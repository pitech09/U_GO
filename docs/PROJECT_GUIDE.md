# U-GO / RideFlow: Project Guide in Plain Language

This document explains what the project is, who uses it, and how the important pieces work. It is written for owners, operations staff, investors, testers, and new team members who do not need to be software engineers.

## 1. What this project is

U-GO is a Lesotho-focused ride platform. It connects people who need transport with drivers who are available to provide it.

The product has one shared application with three experiences:

| Person | What they do |
|---|---|
| Rider | Creates a ride, follows the driver, pays, and rates the completed ride. |
| Driver | Goes online, receives ride offers, accepts work, navigates to the rider, completes rides, and views earnings and history. |
| Administrator | Supervises the platform, manages people and driver verification, views rides and payments, and controls pricing. |

The same project can run on Android, iPhone, and the web. The rider and driver screens are in the mobile-style application; the administrator uses the admin area in that same application.

## 2. A simple picture of the system

```text
Rider phone or browser ─┐
Driver phone or browser ─┼─> U-GO service ──> Redis data store
Admin browser ──────────┘          │
                                   ├─ Maps and route estimates
                                   ├─ Live driver/ride notifications
                                   └─ Payment provider callbacks
```

The application is split into two visible parts:

1. The app is the set of screens people use.
2. The service is the protected central system that remembers users, rides, offers, payments, reviews, and settings.

The data store is the service's memory. It must be backed up and monitored in production. PostgreSQL is mentioned in the configuration as an optional future relational database, but the current ride system uses Redis as its primary store.

## 3. The normal ride, from beginning to end

1. A rider chooses a pickup point and destination.
2. The service calculates an estimated price and route.
3. The rider requests the ride immediately or chooses a future pickup time.
4. The dispatch system finds suitable online drivers based on distance, vehicle capacity, ride type, and availability.
5. The driver sees an offer in New Requests and receives a notification.
6. The first valid driver to accept wins the ride. The central service protects this decision so two drivers should not both become the assigned driver.
7. The driver travels to the pickup point and changes the ride through arriving, arrived, and in progress.
8. The rider can see the driver's location and estimated arrival time when location and routing are available.
9. The driver completes the ride. The fare is recorded with the distance, time, driver earnings, and platform fee.
10. The rider can submit a star rating and private comment. The driver can see completed rides, earnings, ratings, and reviews in History.

## 4. Immediate rides and scheduled rides

An immediate ride is needed now. It is offered to drivers in expanding distance rounds until a driver accepts or no suitable driver remains.

A scheduled ride has a future pickup time. Drivers can accept it ahead of time. Once accepted, it appears in the driver's Scheduled tab. The driver can review the route, see an ETA when routing is available, and release the commitment if they can no longer do it. The service then looks for a replacement driver.

The system also checks for overlapping scheduled commitments. A driver should not be assigned two future rides that conflict with each other.

## 5. What the driver sees

The driver area contains these tabs:

- Home: online/offline control, earnings summary, current location, and nearby work.
- New Requests: ride offers waiting for the driver's decision.
- Scheduled: accepted future rides and relevant scheduled offers.
- Active Trips: the current ride and its status controls.
- History: completed rides, earnings, passenger ratings, and review comments.

Drivers can also complete verification information, provide vehicle details and photos, switch to rider mode, and log out.

## 6. What the administrator controls

Administrators can:

- see platform totals and current activity;
- view rides and their status;
- view riders and drivers;
- suspend or remove non-admin users;
- review driver identity and license submissions;
- approve or reject driver verification;
- review payment submissions and payment status;
- cancel rides when operational intervention is needed;
- change fare rules, driver share, surge settings, dispatch distance, and offer timing.

Admin access is protected by a separate role. It should never be treated as a public feature or shared casually.

## 7. Money and fares

The fare is made from configurable pieces such as base fare, distance, time, passenger count, shared-ride discounts, and parcel adjustments. The final fare is kept on the ride so that later changes to settings do not rewrite an old ride.

Each completed ride records:

- the total amount charged;
- the driver's earnings;
- the platform's fee;
- the payment method and payment status when supplied.

For cash, the rider-facing amount is rounded to the nearest whole loti so the driver does not need to collect small change. Digital payments keep the exact two-decimal fare. The exact calculated fare and rounded cash amount are stored separately.

The application currently supports cash records and manual/mobile-money payment flows. Live M-Pesa or EcoCash collection requires approved merchant credentials, provider callbacks, and production verification before launch.

## 8. Maps and location

The rider and driver can use device location. Maps display pickup, destination, nearby drivers, and route lines. Geoapify can provide route and ETA information when its API key and endpoint configuration are available. Map display and route calculation are separate services: a visible map does not by itself prove that ETA routing is working.

Location permission, a working API address, internet access, and a correctly configured map/routing provider are all required for the live experience.

## 9. Notifications

Notifications have two paths:

- live WebSocket messages for fast updates while the app is connected;
- regular polling as a fallback when a live connection is unavailable.

Ride offers are also stored centrally. This matters because a temporary connection problem should not erase an offer that still exists on the server.

## 10. Important words in everyday language

| Technical word | Plain meaning |
|---|---|
| API | The private conversation channel between the app and the central service. |
| Backend/service | The central program that applies rules and stores data. |
| Database/data store | The place where users, rides, offers, and settings are remembered. |
| Redis | The current primary data store used by this project. |
| PostgreSQL | An optional relational database layer; it is not currently the primary ride store. |
| Dispatch | The process of finding and offering a ride to suitable drivers. |
| Offer | A driver's invitation to accept a particular ride. |
| Scheduled ride | A ride requested for a future pickup time. |
| WebSocket | A live connection used for quick notifications. |
| Polling | Checking the service repeatedly for new information. |
| ETA | Estimated time of arrival. |
| KYC/verification | Checking a driver's identity and driving documents. |
| Environment variable | A private setting supplied to the service at startup, such as a secret or API key. |

## 11. What “ready” means

The project has the main product flows and automated route/dispatch checks. Before a public launch, the team still needs to prove the deployed environment: backups and restore, Redis failover, real mobile-money callbacks, real Geoapify routing, mobile device permissions, notification behavior, monitoring, and a complete security/privacy review.

Passing a code test means the code behaved correctly in that test. It does not by itself prove that a production phone, network, payment provider, or deployed server is configured correctly.
