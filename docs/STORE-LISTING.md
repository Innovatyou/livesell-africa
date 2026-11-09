# LiveSell app — store listing

Draft copy for Google Play and the App Store. Edit freely before submitting.

## Identity

| Field | Value |
|---|---|
| App name | LiveSell — Sell Live |
| Package / bundle id | `africa.livesell.seller` (Android package matches the Firebase project `africa-livesell-seller`) |
| Category | Business |
| Content rating | Everyone (no user-generated public content in the app) |
| Price | Free (LiveSell plans are billed on the web; the app has no in-app purchases) |

## Short description (Play, max 80 characters)

> Run your live sales, orders, stock and payments from your phone.

## Subtitle (App Store, max 30 characters)

> Live selling made simple

## Full description

> LiveSell is the seller app for live commerce in Nigeria. Go live on TikTok, Instagram or Facebook and record orders the moment viewers comment a product code. LiveSell holds the stock and sends the customer a payment link.
>
> **Run your live**
> - Record orders by product code (BAG001) while you sell
> - Stock is held as soon as the order is saved: no overselling
> - No signal? Orders are saved on your phone and sent automatically
>
> **Get paid**
> - Card, bank transfer and USSD through Paystack, Flutterwave and Bachs
> - Confirm bank transfers in one tap, only when the money is in your account
> - Instant notifications for new orders and transfers to check
>
> **Deliver**
> - Your own riders or courier companies, with tracking numbers
> - Customers get WhatsApp and SMS updates automatically
>
> **Know your numbers**
> - Today's sales, orders to fulfil, top products
> - Analytics by channel and live session
>
> Manage products and photos, delivery zones, store details and your plan, all from the app.

## Keywords (App Store, 100 characters)

> live selling,tiktok shop,instagram,orders,inventory,paystack,whatsapp,nigeria,seller,ecommerce

## Screenshots to capture (6.7" iPhone + Android phone)

1. Live console recording an order by code.
2. Today dashboard.
3. Order with "Confirm payment received".
4. New order notification.
5. Product with photos and stock.
6. Analytics.

## Privacy

**App Store "nutrition label" and Play Data safety.** The app collects:
- name, email and phone of the seller (account);
- customer names and phone numbers the seller enters (orders);
- photos the seller chooses (products);
- a device push token.

All of it is linked to the account, used for app functionality, and not used for tracking or advertising.

**Not collected:** location, contacts or payment card details. Card payments happen on the payment provider's page.

**Privacy policy URL:** https://app.livesell.africa/privacy

**Support URL:** https://app.livesell.africa (Contact).

**Account deletion:** in-app link to support plus the NDPA request process (Play requires a deletion URL).

## Review notes (for Apple / Google reviewers)

- Provide a demo store login, for example `demo@livesell.local`. Use a staging account seeded with `npm run seed:demo` on the staging server, never production data.
- Explain that the payment links open the payment provider's checkout for the seller's customers. The app sells no digital goods, so in-app purchase rules don't apply.
