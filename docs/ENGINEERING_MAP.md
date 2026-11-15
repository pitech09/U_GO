# U-GO Engineering Map

This file explains where the project code lives and what a developer should change for each kind of work.

## Repository map

| Location | Responsibility |
|---|---|
| `app/` | Expo Router screens for welcome, login, registration, rider, driver, scheduled rides, history, verification, and admin. |
| `components/` | Shared visual components such as maps, error handling, modals, and the driver tab bar. |
| `lib/` | Frontend support: authentication context, API requests, query caching, sounds, and live connection handling. |
| `server/index.ts` | Starts the HTTP service, configures middleware, health checks, and graceful shutdown. |
| `server/routes.ts` | HTTP endpoints and authorization checks for users, rides, offers, payments, reviews, admin actions, and configuration. |
| `server/storage.ts` | Redis-backed persistence and atomic ride/offer operations. This is the main data access layer. |
| `server/dispatch.ts` | Finds drivers, creates offers, expands dispatch rounds, activates scheduled rides, and handles no-driver outcomes. |
| `server/auth.ts` | Password hashing, access-token signing, token verification, and role checks. |
| `server/realtime.ts` | Authenticated WebSocket connections and live user notifications. |
| `server/payments.ts` | Payment-provider adapter boundary and payment status behavior. |
| `shared/schema.ts` | Shared TypeScript types and Zod validation used by the app and service. |
| `shared/fare.ts` | Fare calculation and driver/platform split. |
| `shared/distance.ts` | Distance calculations used by driver matching and estimates. |
| `scripts/` | Automated checks and build helpers. |
| `docs/` | Human-readable product and engineering documentation. |

## Main data objects

- User: rider, driver, or administrator account, including driver vehicle and verification information.
- Ride: pickup, destination, status, fare, payment, assigned driver, schedule, and review.
- Ride offer: a time-limited invitation for a specific driver to accept a specific ride.
- Event: a notification stored for a user, such as a new offer or ride status change.
- Platform configuration: fare rules, dispatch radius, offer window, shared-ride discounts, and related settings.

## Important rules

1. The server is the authority. The app may display a state, but the server decides whether a ride can be accepted or changed.
2. Every protected request should carry the access token and be checked for ownership or admin permission.
3. Acceptance must be atomic. Only one eligible driver can win the same private ride.
4. An accepted scheduled ride is a commitment. Check capacity and time conflicts before accepting it.
5. Do not expose passwords, document images, private review content, or payment secrets in public responses.
6. Keep fare values on the ride. Changing the configuration should affect new calculations, not rewrite historical rides.
7. Preserve persisted offers during temporary polling or network failures. A failed read must not be treated as an empty list.

## Frontend flow

The app reads `EXPO_PUBLIC_DOMAIN` to find the service. Login stores the access token locally and sends it with later requests. React Query handles server data, while the authentication context controls the current user and role.

The driver screen combines live WebSocket notifications with polling. The Scheduled and History screens read the driver's server-side records, so changing tabs should not erase existing offers or rides.

## Backend flow

The Express service receives a request, authenticates it, validates its input, checks ownership or admin permission, updates Redis through the storage layer, and returns JSON. Ride-related changes also create events and can publish a WebSocket update.

Redis uses structured keys for users, rides, offers, events, dispatch state, and configuration. Several acceptance and dispatch operations use Redis-side conditional logic so concurrent drivers cannot both claim one ride.

## Environment settings

Copy `.env.example` to `.env` for local work. The most important settings are:

- `PORT`: service port, normally `5000` locally.
- `EXPO_PUBLIC_DOMAIN`: host and port used by the app to reach the service.
- `REDIS_URL`: managed Redis address for production.
- `SESSION_SECRET`: secret used to sign access tokens; required in production.
- `INITIAL_ADMIN_PASSWORD`: one-time admin seed password for a new production store.
- `DATABASE_URL`: optional PostgreSQL connection; adding it alone does not move ride persistence to PostgreSQL.
- payment provider settings: only configure with approved provider credentials and callback URLs.

Keep real `.env` files out of Git. Use a secret manager in production.

## Local development

```bash
npm install
cp .env.example .env
npm run server:dev
# in another terminal
npm run expo:dev
```

Useful checks:

```bash
npm run test:routes
npm run test:scheduled-dispatch
npx tsc --noEmit
git diff --check
```

For an Android emulator, the host machine is commonly reached as `10.0.2.2`. A physical phone needs the computer's LAN address and must be able to reach the service over the same network.

## Release checklist

- Run the automated tests and TypeScript check.
- Build the service and the Expo web/mobile target intended for release.
- Configure HTTPS, production secrets, managed Redis persistence, backups, replication/failover, and monitoring.
- Verify `/api/health` from the deployed environment.
- Test login, rider booking, driver offer acceptance, scheduled rides, history, review submission, and cancellation.
- Test two drivers accepting the same ride and confirm there is exactly one winner.
- Test payment success, failure, timeout, webhook signature rejection, and reversal where applicable.
- Test real device location permissions, background behavior, WebSocket reconnect, and polling fallback.
- Confirm logs do not contain passwords, tokens, document images, wallet PINs, or unnecessary personal data.
- Record the release commit and rollback procedure.

## Known boundaries

- Redis is the current primary data store. PostgreSQL configuration is scaffolded but is not an automatic migration or backup strategy.
- Payment provider integrations require external merchant approval and live credentials.
- Map display can work while routing/ETA is misconfigured; verify both independently.
- A passing local test suite does not prove that production infrastructure, phones, payment providers, or network permissions work.
