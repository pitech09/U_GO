# U-GO Operations Guide

This is the day-to-day guide for a non-technical operator or business owner.

## Start-of-day checklist

- Confirm the service health page responds.
- Confirm the data store is connected and its backup is recent.
- Confirm the admin can log in.
- Confirm at least one test driver can go online.
- Place a small test ride in a safe test environment.
- Confirm the offer appears to the driver and that accepting it updates the rider view.
- If scheduled rides are in use, create a test scheduled booking and confirm it appears in the driver's Scheduled tab.
- Confirm map and ETA behavior in the actual operating area.

## Driver onboarding

1. The driver registers with a name, phone number, and vehicle information.
2. Operations checks the submitted identity and driving documents.
3. Operations approves or rejects the verification from the admin area.
4. Operations checks vehicle capacity, registration details, and contact information.
5. Only an approved driver should be allowed to operate under the business's real policy.

The application stores a verification status, but the business is responsible for deciding what legal and operational evidence is required in Lesotho.

## Handling a normal ride

Use the ride list to find the ride and its current status. A healthy ride normally moves from requested to accepted, arriving, arrived, in progress, and completed. A ride can also be cancelled or finish as no drivers available.

If a rider says no driver can see the request:

1. Confirm the driver is online.
2. Confirm the driver's location permission and recent location.
3. Check that the vehicle has enough seats for the passenger count.
4. Check that the driver is not already on a private active ride.
5. Check the driver's New Requests tab and then refresh it.
6. Check the service logs and the ride's offer records.

If a driver accepted one ride and other offers disappeared, first check whether those offers belonged to the same ride. Offers for the accepted ride should close for other drivers; unrelated persisted offers should remain visible until accepted, rejected, or expired.

## Handling a scheduled ride

The Scheduled tab is for future rides that have been accepted by a driver. The operator should check:

- pickup date and time;
- driver name and vehicle;
- route and estimated travel time;
- whether the driver's other accepted scheduled rides overlap;
- whether the driver has released the ride;
- whether a replacement driver is needed.

If the assigned driver releases a scheduled ride, monitor the booking for a replacement. Contact the rider if the replacement cannot be found in time.

## Payments

The supported payment records include cash, M-Pesa, and EcoCash states. A payment can be waiting, paid, rejected, failed, or awaiting provider confirmation.

For manual proof:

- check the transaction reference and attached proof;
- compare the amount and ride before approving;
- do not request or store a wallet PIN;
- record who verified the payment.

For live mobile money, do not launch until the provider account, callback URL, signing secret, test transactions, failure handling, and reversal process have all been tested.

## Rating and review handling

Riders can rate a completed ride. The driver History tab shows the driver's completed rides, earnings, average rating, and review comments available to the driver. Admins can see operational review information.

Treat review comments as private customer information. Use them to coach, investigate complaints, and identify repeat safety problems. Do not publish private comments without a clear policy and permission.

## Common symptoms and first actions

| Symptom | First checks |
|---|---|
| App cannot connect | Service health, API address, device network, HTTPS certificate, and server logs. |
| Driver sees no offer | Online status, location, vehicle capacity, active ride, offer record, then refresh. |
| Scheduled ride missing | Correct driver account, accepted assignment, future pickup time, and `/scheduled` response. |
| Map appears but ETA is absent | Geoapify key, route endpoint, coordinates, quota, and server response. |
| Payment stays pending | Provider callback, transaction reference, webhook signature, and admin verification. |
| Rider and driver show different status | Check service logs and the ride record; refresh both clients before changing data. |
| Data disappears after restart | Check Redis persistence, disk space, backups, and whether the service connected to a different Redis instance. |

## Sensitive information rules

- Never share `.env` files, access tokens, passwords, payment secrets, or webhook secrets.
- Never put wallet PINs into the application or support tickets.
- Give admin access only to named staff.
- Remove or rotate credentials when a staff member leaves.
- Use a separate test account and test payment credentials for demonstrations.

## Escalation information to collect

When reporting a problem, collect the ride ID, user/driver ID, approximate local time, screen name, exact error message, device type, network type, and whether a refresh changed the result. Do not attach passwords, tokens, identity documents, or payment secrets.
