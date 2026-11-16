# U-GO Code Engines Explained

This guide explains the most important parts of the code in everyday language. It is intended for a product owner, operations person, tester, or new developer who wants to understand what the application is doing without reading every file.

## 1. The big idea: the app asks, the service decides

The screens in `app/` are the part people touch. They show forms, maps, buttons, tabs, and messages.

The service in `server/` is the decision-maker. It checks identity, validates requests, applies ride and fare rules, writes data, and tells other users what changed.

```text
Person taps a button
        |
        v
App sends a request with the user's access token
        |
        v
server/routes.ts checks permission and input
        |
        v
server/storage.ts performs the protected data operation
        |
        v
Redis stores the result and the service sends an event/update
```

The user interface can be refreshed, closed, or temporarily disconnected. The central service and data store must remain the source of truth.

## 2. The major engines

### Authentication and permissions engine

Files: `server/auth.ts`, `lib/auth-context.tsx`, and the protected sections of `server/routes.ts`.

This engine answers two questions:

1. Who is this person?
2. Is that person allowed to do this particular action?

Passwords are hashed with scrypt before being stored. After login, the service gives the app a signed access token. The app stores the token locally and sends it with later requests.

Role checks are not enough on their own. For example, being a driver does not mean a driver can accept on behalf of another driver. The route also checks ownership: the authenticated driver's ID must match the driver ID being used.

### Ride lifecycle engine

Files: `shared/schema.ts` and ride status routes in `server/routes.ts`.

A ride has a status that describes where it is in its journey:

```text
scheduled -> requested -> accepted -> arriving -> arrived -> in_progress -> completed
     |           |             |
     +-----------+-------------+----> cancelled / no_drivers_available
```

Scheduled rides remain scheduled after a driver reserves them. They become active at the pickup time. The scheduler uses an atomic operation so a scheduled ride that already has a driver is not accidentally turned back into an unassigned request.

The service records timestamps such as accepted time, arrival time, start time, and completion time. These timestamps are useful for customer support, earnings, reporting, and future service-level measurements.

### Fare calculation engine

File: `shared/fare.ts`.

The fare engine is a pure calculation: it receives distance, platform settings, passenger information, ride type, and optional parcel information, then returns a complete breakdown.

For a normal private ride:

```text
distanceFare = distanceKm x pricePerKm
timeFare     = estimatedMinutes x pricePerMinute
tripSubtotal = max(baseFare + distanceFare + timeFare, minimumFare)
totalFare    = tripSubtotal x surgeMultiplier (when surge is on)
```

The current time estimate is derived from distance using the formula in `shared/fare.ts`. It is an estimate for pricing; route providers may return a different travel time for navigation and ETA.

For a shared ride:

```text
discountedSubtotal = max(minimumFare, tripSubtotal x (1 - sharedDiscount / 100))
passengerMultiplier = 1 + (additionalPassengers x 10%)
totalFare = discountedSubtotal x passengerMultiplier x surgeMultiplier
```

Shared pricing is for the individual booking. Matching several shared riders into one vehicle is handled by dispatch and capacity rules, not by multiplying one rider's fare by the number of people in the vehicle.

For parcels, the engine calculates weight and volume units and applies the larger multiplier. A parcel is therefore priced as additional transport load, while the ride still retains its own route and passenger rules.

At the end:

```text
driverEarnings = totalFare x driverSharePercent
platformFee    = totalFare - driverEarnings
```

All returned digital fare values are rounded to two decimal places. A separate `cashTotalFare` rounds the total to the nearest whole loti for cash collection. The calculated fare is saved on the ride, which protects historical rides from later fare-setting changes. Cash payment records store the rounded amount, while mobile-money records store the exact amount.

### Distance and eligibility engine

File: `shared/distance.ts`, with matching logic in `server/dispatch.ts` and `server/storage.ts`.

The distance helper uses the Haversine calculation. In simple terms, it estimates the straight-line distance between two latitude/longitude points on Earth. It is useful for deciding who is nearby, but it is not the same as driving distance on roads.

Before an offer is created, the service checks items such as:

- driver is actually a driver;
- driver is online and not suspended;
- vehicle capacity is known and within the allowed range;
- passenger or parcel capacity is sufficient;
- driver is within the configured dispatch radius;
- driver is not already occupied by a conflicting private ride;
- scheduled commitments do not overlap.

### Dispatch engine

File: `server/dispatch.ts`.

For immediate rides, dispatch works in rounds:

1. Start with the initial radius.
2. Find eligible drivers.
3. Create a time-limited offer for every eligible driver in that round.
4. Wait for the offer window to expire or for somebody to accept.
5. Expand the radius and repeat if the ride is still unassigned.
6. Mark the ride as having no drivers when the maximum radius is reached.

The scheduler runs frequently, but a Redis dispatch lock prevents multiple service instances from processing the same dispatch queue at the same time. If the service restarts, stored dispatch state and offer expiry times allow it to recover instead of silently forgetting work.

Scheduled rides are advertised separately because they can be accepted before pickup time. At pickup time, the scheduler atomically activates the ride and then normal dispatch rules can continue where necessary.

### Offer and notification engine

An offer is stored centrally with a driver ID, ride ID, expiry time, and status. The driver screen reads those persisted offers instead of relying only on a live notification.

After an offer is stored, the service:

1. writes a user event;
2. publishes a WebSocket message when the driver is connected;
3. lets the app's polling fallback discover the same offer if the live connection is unavailable.

This separation is important: a notification is only a signal that something changed. The stored offer is the actual work item.

### Realtime and recovery engine

File: `server/realtime.ts` and `lib/realtime.ts`.

WebSockets provide quick updates while a driver or rider is connected. They are not the permanent record. If a phone sleeps, loses signal, or reconnects, the app polls the service and reloads server-side data.

This is why a temporary failed request should preserve the last known offers on the driver screen rather than replace them with an empty list.

### Payments engine

Files: `server/payments.ts` and payment routes in `server/routes.ts`.

The payment engine separates the ride from the payment status. A ride may exist before payment is complete. Payment states include waiting for cash, waiting for verification, waiting for a provider, paid, rejected, and failed.

Provider webhooks are checked with a signature before the service changes a payment. A provider transaction ID is kept so an administrator can investigate or reverse a transaction where the provider supports it.

The current code has an adapter boundary for M-Pesa and EcoCash. Real collection still depends on approved provider accounts, credentials, callback URLs, and live testing.

### Reviews and driver history engine

After a ride is completed, the rider can submit one rating and optional comment. The service prevents a second review for the same ride and updates the driver's average rating.

The driver History screen reads completed rides and shows earnings, ratings, and available review comments. This data is derived from stored rides; it is not a separate hand-maintained list.

## 3. How the race-condition protection works

### The problem

Suppose Driver A and Driver B both see the same offer and tap Accept almost simultaneously:

```text
Driver A: read ride = available
Driver B: read ride = available
Driver A: assign ride to A
Driver B: assign ride to B
```

If the code only reads the ride and then writes a new assignment, both requests can pass their checks. The last write could overwrite the first driver, or both drivers could be told they won.

### The protection used here

The final acceptance is performed by `acceptRideOffer()` in `server/storage.ts` using one Redis Lua script. Redis executes that script atomically: other acceptance scripts cannot interleave their changes halfway through it.

Inside that one protected operation, the service checks:

1. the ride still exists;
2. the driver exists, is a real driver, is online, and is not suspended;
3. the driver has valid capacity;
4. the driver's offer still exists, is pending, and has not expired;
5. the ride is still requested or scheduled;
6. the driver's active rides and remaining capacity allow this booking.

Only after all checks pass does the script assign the driver and write the ride. It then marks the winning offer accepted and withdraws offers for the same ride from other drivers. Offers for unrelated rides remain in the driver's queue.

The result is a single winner:

```text
Request A enters atomic Redis script -> ride changes to assigned to A -> A wins
Request B enters after the change  -> ride is no longer available      -> B gets 409
```

The HTTP route performs some early checks, such as scheduled overlap detection, to provide a fast and friendly error. Those checks are not the final race-condition barrier. The atomic storage operation is the final authority.

### Other race protections

- Dispatch startup uses an atomic “create only if absent” operation so the same ride is not queued twice.
- A scheduler lock prevents two scheduler loops from processing the same due dispatches concurrently.
- Scheduled activation checks the current ride state and driver assignment inside Redis before changing the status.
- Offer expiration and acceptance both verify the current state instead of trusting an old screen response.
- A driver's active private ride blocks new private offers; shared rides are checked against remaining capacity.

### What must not be changed casually

Do not move the final assignment into a sequence of ordinary `get` then `set` calls. Do not rely on the app to decide whether a ride is still available. Do not remove the offer expiry check. Those changes would reintroduce the exact concurrency bug this design is intended to prevent.

## 4. How to test the important behavior

Run the focused checks:

```bash
npm run test:routes
npm run test:scheduled-dispatch
npx tsc --noEmit
```

The most important concurrency test creates offers for two drivers and attempts acceptance concurrently. The expected result is one successful acceptance and one unavailable/conflict response. A successful test proves the code path under test; it does not replace a live deployment test against the production Redis setup.

## 5. Where to look when debugging

| Question | Start here |
|---|---|
| Why is the price wrong? | `shared/fare.ts`, ride's saved `fare`, and admin platform configuration. |
| Why did a driver not receive an offer? | `server/dispatch.ts`, driver location/status/capacity, and persisted offers. |
| Why did an offer disappear? | `server/storage.ts` offer status, ride ID, expiry, and whether the same ride was accepted elsewhere. |
| Why did two drivers appear to accept? | Redis availability, `acceptRideOffer()` result logs, and the concurrent acceptance test. |
| Why is a scheduled ride missing? | `server/routes.ts` scheduled endpoint, assignment status, pickup time, and scheduler logs. |
| Why is the ETA missing? | Route-provider configuration and the route request; map display alone is not enough. |
| Why did data change after restart? | Redis URL, persistence, backups, and whether the service connected to the expected Redis instance. |

## 6. One-sentence summary

The screens make requests, the service applies the rules, Redis performs the critical state changes atomically, and the saved ride record is the history that all users and devices should eventually agree on.
