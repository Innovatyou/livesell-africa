/**
 * LiveSell Academy: short, practical classes for sellers who've never sold live. Written for Nigerian social sellers.
 * Platform rules change; lessons say "check the app" where TikTok / Meta set the requirements, and never promise results.
 */
import type { IconName } from '@/components/ui';

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  steps: Array<{ title: string; body: string }>;
  tips?: string[];
  avoid?: string[];
  /** One question to check understanding. */
  check?: { question: string; options: string[]; answer: number; why: string };
  /** "Do it now" buttons that open the right LiveSell screen. */
  actions?: Array<{ title: string; href: string }>;
}
export interface Track { id: string; title: string; subtitle: string; icon: IconName; color: string; level: 'Start here' | 'Beginner' | 'Grow'; lessons: Lesson[] }

export const TRACKS: Track[] = [
  {
    id: 'start', title: 'Start here: your first sale', subtitle: 'Set up LiveSell in 15 minutes', icon: 'rocket-outline', color: '#0e7a4d', level: 'Start here',
    lessons: [
      {
        id: 'start-how', title: 'How live selling works', minutes: 3,
        summary: 'You go live on TikTok, Instagram or Facebook. Viewers comment a product code. LiveSell turns each comment into an order, holds the stock and sends the payment link.',
        steps: [
          { title: 'Show the item', body: 'Hold it close to the camera, say its price and its code: “This bag is BAG001, ₦25,000.”' },
          { title: 'Viewers comment the code', body: 'Ask them to comment “BAG001” or send it to your WhatsApp. One code = one item, no confusion.' },
          { title: 'You (or a helper) record the order', body: 'In LiveSell’s live console, tap the product and add the buyer’s name and phone. Stock is held at once, so you never sell the last one twice.' },
          { title: 'The buyer gets a payment link', body: 'By WhatsApp or SMS. They pay by card, transfer or USSD. The order turns PAID only when the money is confirmed — never from a screenshot.' },
          { title: 'Pack and deliver', body: 'Your rider or courier delivers; the buyer gets “on its way” and “delivered” messages automatically.' },
        ],
        check: { question: 'When does LiveSell mark an order as paid?', options: ['When the buyer sends a screenshot', 'When the payment provider or you confirm the money arrived', 'As soon as the order is recorded'], answer: 1, why: 'Fake transfer alerts are common. Only confirmed money counts.' },
      },
      {
        id: 'start-products', title: 'Add your first 5 products', minutes: 5,
        summary: 'Good photos, a clear price and a short code are all you need.',
        steps: [
          { title: 'Take bright photos', body: 'Near a window, plain background, the whole item in frame. Add 2–3 angles.' },
          { title: 'Name it like a buyer would search', body: '“Black leather handbag, medium” beats “New arrival 🔥”. LiveSell makes the code from the name (BAG001); you can change it.' },
          { title: 'Set the price and stock', body: 'Count what you really have. If you can get more after payment, switch on pre-orders in Store settings.' },
          { title: 'Sizes and colours', body: 'Turn on “This product has options”, type the sizes (S, M, L) and colours, and set stock for each.' },
        ],
        tips: ['Start with your 5 best sellers, not your whole shop.', 'Keep codes short and easy to say out loud.'],
        actions: [{ title: 'Add a product', href: '/products/new' }],
      },
      {
        id: 'start-payments', title: 'Get paid safely', minutes: 4,
        summary: 'Connect a payment provider and a bank account for transfers so buyers can pay the way they like.',
        steps: [
          { title: 'Bank transfer account', body: 'Add the account buyers transfer to. You confirm each transfer in the order once the money is in your account.' },
          { title: 'Card and USSD (optional)', body: 'Connect Paystack, Flutterwave or Bachs, or “Get paid through LiveSell” to your bank with no extra account.' },
          { title: 'Check before you send', body: 'Only dispatch orders marked PAID. Ignore screenshots and “I don pay” messages until the money shows.' },
        ],
        avoid: ['Sending goods because of a transfer screenshot.', 'Sharing your OTP or payment keys with anyone, including “support”.'],
        actions: [{ title: 'Set up payments', href: '/settings/payments' }],
      },
      {
        id: 'start-delivery', title: 'Delivery and pickup', minutes: 3,
        summary: 'Set your delivery prices by area once; LiveSell adds the right fee to each order.',
        steps: [
          { title: 'Add delivery zones', body: 'For example: Lekki ₦2,500, Ikeja ₦3,000, Outside Lagos ₦5,000.' },
          { title: 'Add your riders or courier', body: 'Pick who delivers each order; the buyer gets tracking messages.' },
          { title: 'Offer pickup', body: 'If buyers can collect, switch on pickup and add your address.' },
        ],
        actions: [{ title: 'Delivery settings', href: '/settings/delivery' }],
      },
    ],
  },
  {
    id: 'tiktok', title: 'Selling on TikTok Live', subtitle: 'Go live, get viewers, take orders', icon: 'logo-tiktok', color: '#111111', level: 'Beginner',
    lessons: [
      {
        id: 'tiktok-access', title: 'Getting access to TikTok LIVE', minutes: 4,
        summary: 'TikTok decides who can go live. Requirements (age, followers) change and differ by country, so check inside the app.',
        steps: [
          { title: 'Check if you can go live', body: 'Open TikTok → tap + → swipe to “LIVE”. If you see it, you can. If not, TikTok shows what’s missing.' },
          { title: 'Typical requirements', body: 'You usually must be 18+ and may need a minimum number of followers (often around 1,000). TikTok can change this at any time.' },
          { title: 'Grow while you wait', body: 'Post short videos of your products every day: unboxing, try-ons, “3 ways to style”. Put your store link in your bio.' },
          { title: 'Use a business account', body: 'Settings → Account → Switch to Business account. You get insights and a link in bio.' },
        ],
        tips: ['Post at the times your followers are online (TikTok insights show this).', 'Reply to comments with videos — it brings people back.'],
        avoid: ['Buying followers: TikTok can limit or ban accounts for it.', 'Reposting other sellers’ videos.'],
        check: { question: 'Where do you check whether your account can go live?', options: ['In the TikTok app, on the LIVE option', 'In LiveSell', 'TikTok sends an SMS'], answer: 0, why: 'Only TikTok knows your eligibility; it shows it where you start a LIVE.' },
      },
      {
        id: 'tiktok-setup', title: 'Your live setup (with one phone or two)', minutes: 5,
        summary: 'Good light and clear sound matter more than an expensive camera.',
        steps: [
          { title: 'Two phones is best', body: 'Phone 1 streams on TikTok on a tripod. Phone 2 runs LiveSell to record orders — or a helper does it.' },
          { title: 'Light', body: 'Face a window or use a ring light. Avoid a bright window behind you.' },
          { title: 'Sound', body: 'Quiet room, phone close to you. A cheap clip-on mic helps a lot.' },
          { title: 'Data and power', body: 'Strong Wi-Fi or a full data bundle, phone charging during the live. LiveSell saves orders even if your network drops and sends them later.' },
          { title: 'Products ready', body: 'Arrange items in the order you’ll show them, with their codes on small cards.' },
        ],
        tips: ['Do a 5-minute test live first to check light and sound.'],
      },
      {
        id: 'tiktok-run', title: 'Running a live that sells', minutes: 6,
        summary: 'A simple script keeps viewers watching and ordering.',
        steps: [
          { title: 'Open strong (first 30 seconds)', body: '“Welcome! Today: 10 new bags, 2 flash deals at 8pm. Comment the code to buy.”' },
          { title: 'One item at a time', body: 'Show it, say the code and price twice, show details (inside, size, colour). 2–4 minutes per item.' },
          { title: 'Repeat how to order', body: 'Every few minutes: “Comment the code, we’ll send you a payment link on WhatsApp.” New viewers join all the time.' },
          { title: 'Create urgency honestly', body: 'Flash price for 10 minutes, or “only 3 left” — only if it’s true. LiveSell shows real stock.' },
          { title: 'Thank buyers by name', body: '“Thank you Amaka for BAG001!” Others see people are buying.' },
          { title: 'Close', body: 'Recap what’s left, remind people to pay their links, say when your next live is.' },
        ],
        tips: ['Go live at the same days and times so followers know when to come.', 'Lives of 45–90 minutes usually work better than 10-minute ones.'],
        avoid: ['Long silences while you look for items.', 'Fake scarcity — buyers notice and stop trusting you.'],
        check: { question: 'Why repeat how to order every few minutes?', options: ['TikTok requires it', 'New viewers join all the time', 'It makes the live longer'], answer: 1, why: 'Most viewers didn’t see your first explanation.' },
        actions: [{ title: 'Create a live session', href: '/live/new' }],
      },
      {
        id: 'tiktok-after', title: 'After the live: turn comments into cash', minutes: 3,
        summary: 'Most money is lost after the live, when buyers forget to pay.',
        steps: [
          { title: 'Check unpaid orders', body: 'Orders → Awaiting payment. LiveSell sends reminders automatically; you can send one more from the order.' },
          { title: 'Confirm transfers', body: 'When a buyer reports a transfer, check your bank, then confirm the exact amount in LiveSell.' },
          { title: 'Dispatch paid orders the same day', body: 'Fast delivery brings buyers back to your next live.' },
          { title: 'Read the session report', body: 'See what sold and what didn’t — plan your next live around it.' },
        ],
        actions: [{ title: 'See orders awaiting payment', href: '/orders?view=awaiting_payment' }],
      },
    ],
  },
  {
    id: 'instagram', title: 'Selling on Instagram Live', subtitle: 'Lives, stories and DMs that convert', icon: 'logo-instagram', color: '#c13584', level: 'Beginner',
    lessons: [
      {
        id: 'ig-start', title: 'Going live on Instagram', minutes: 4,
        summary: 'Most accounts can go live from the camera: swipe to “Live”. Use a professional (business or creator) account for insights.',
        steps: [
          { title: 'Switch to a professional account', body: 'Settings → Account type and tools → Switch to professional account.' },
          { title: 'Announce your live', body: 'Post a story 1–2 days before and on the day: “Friday 8pm live: new bags, flash deals.” Instagram lets you schedule a live so followers get a reminder.' },
          { title: 'Go live', body: 'Tap + → Live. Add a title like “BAG DROP — comment the code to buy”.' },
          { title: 'Pin a comment', body: 'Pin: “Comment the product code (BAG001) or DM us to order.”' },
        ],
        tips: ['Invite a friend or another seller to co-host — you share audiences.', 'Save the live and post it afterwards so more people can see it (check the option at the end).'],
      },
      {
        id: 'ig-dms', title: 'Stories, DMs and your store link', minutes: 4,
        summary: 'Between lives, stories and DMs keep sales coming.',
        steps: [
          { title: 'Put your LiveSell store link in your bio', body: 'Buyers can browse and pay without DMs. Find it in More → Store settings.' },
          { title: 'Post products in stories with codes', body: 'Add the code as text: “BAG001 ₦25,000 — link in bio.”' },
          { title: 'Answer DMs fast with the code', body: 'Record the order in LiveSell and the buyer gets a payment link — no back-and-forth about account numbers.' },
        ],
        avoid: ['Typing your bank account in every DM — use payment links so each payment is matched to its order.'],
        check: { question: 'Best way to take payment from a DM?', options: ['Send your account number and wait', 'Record the order so LiveSell sends a payment link', 'Ask for a screenshot'], answer: 1, why: 'The link matches the payment to the order and confirms it automatically.' },
        actions: [{ title: 'Store settings', href: '/settings/store' }],
      },
    ],
  },
  {
    id: 'facebook', title: 'Selling on Facebook Live', subtitle: 'Pages, groups and Marketplace buyers', icon: 'logo-facebook', color: '#1877f2', level: 'Beginner',
    lessons: [
      {
        id: 'fb-start', title: 'Going live on a Page or in groups', minutes: 4,
        summary: 'Go live from your business Page; share it into groups where your buyers are (follow each group’s rules).',
        steps: [
          { title: 'Create a Facebook Page for your business', body: 'Use your store name and logo, add your WhatsApp number and LiveSell store link.' },
          { title: 'Go live from the Page', body: 'On the Page: Create → Live video. You can schedule it so followers are reminded.' },
          { title: 'Share to groups', body: 'Share the live into buy-and-sell groups that allow it. Read group rules first.' },
          { title: 'Same order flow', body: 'Viewers comment the code; you record orders in LiveSell; they get payment links.' },
        ],
        tips: ['Older buyers are often on Facebook — speak clearly and explain how to pay step by step.'],
        avoid: ['Spamming groups with the same post — admins remove sellers who do.'],
      },
    ],
  },
  {
    id: 'whatsapp', title: 'Selling with WhatsApp', subtitle: 'Status, broadcasts and order-by-code', icon: 'logo-whatsapp', color: '#25d366', level: 'Beginner',
    lessons: [
      {
        id: 'wa-business', title: 'WhatsApp Business basics', minutes: 4,
        summary: 'Your buyers already live on WhatsApp. Use it for status updates and quick orders.',
        steps: [
          { title: 'Use WhatsApp Business', body: 'Add your business name, hours, address and LiveSell store link.' },
          { title: 'Post products on Status with codes', body: '“SHOE014 ₦18,000 — reply with the code to order.”' },
          { title: 'Order by code', body: 'If your store has WhatsApp ordering, a buyer who sends “SHOE014” is guided through size, quantity and address, and gets a payment link automatically.' },
          { title: 'Only message people who agreed', body: 'LiveSell messages only buyers who opted in and stops when they reply STOP.' },
        ],
        avoid: ['Adding people to broadcast lists without asking.'],
        actions: [{ title: 'Customer messages', href: '/settings/messages' }],
      },
    ],
  },
  {
    id: 'grow', title: 'Grow your business', subtitle: 'Pricing, trust, team and numbers', icon: 'trending-up-outline', color: '#b4510f', level: 'Grow',
    lessons: [
      {
        id: 'grow-trust', title: 'Build trust so buyers pay', minutes: 4,
        summary: 'Nigerian buyers fear “what I ordered vs what I got”. Trust is your biggest sales tool.',
        steps: [
          { title: 'Show real items', body: 'Film the actual item, not stock photos. Show flaws if any.' },
          { title: 'Verify your business', body: 'Registered with CAC? Submit it in Business verification to get a verified badge on your store.' },
          { title: 'Post delivery proof', body: 'Share (with permission) happy customer videos and delivery photos.' },
          { title: 'Clear policies', body: 'Say upfront: delivery times, returns, what happens if an item is faulty.' },
        ],
        actions: [{ title: 'Verify my business', href: '/verification' }],
      },
      {
        id: 'grow-pricing', title: 'Pricing and flash deals', minutes: 4,
        summary: 'Price so you still make money after delivery and fees.',
        steps: [
          { title: 'Know your real cost', body: 'Item + transport to you + packaging + payment fees. Price above that with a margin you’re happy with.' },
          { title: 'Live-only prices', body: 'When creating a live session, set a live price for a product — it applies only to orders in that live.' },
          { title: 'Bundles', body: '“Bag + purse ₦32,000” moves more stock than two separate prices.' },
        ],
        avoid: ['Discounts so deep you lose money after delivery.'],
      },
      {
        id: 'grow-team', title: 'Add a helper to your live', minutes: 3,
        summary: 'One person sells on camera, another records orders. Sales go up when nobody waits.',
        steps: [
          { title: 'Invite them with the right role', body: 'Live moderator records orders during lives; Dispatch & delivery packs and sends; Accounts confirms transfers.' },
          { title: 'Each role sees only what it needs', body: 'Helpers can’t see your payouts or change settings unless you allow it.' },
          { title: 'Remove access any time', body: 'One tap in Team & roles.' },
        ],
        actions: [{ title: 'Team & roles', href: '/team' }],
      },
      {
        id: 'grow-numbers', title: 'Read your numbers', minutes: 3,
        summary: 'Do more of what sells.',
        steps: [
          { title: 'Best products', body: 'Analytics shows what sells most — feature it early in your next live.' },
          { title: 'Best channel', body: 'Compare TikTok vs Instagram vs WhatsApp sales; put your time where buyers are.' },
          { title: 'Unpaid rate', body: 'If many orders go unpaid, shorten the time between the live and the payment link, and send reminders.' },
        ],
        actions: [{ title: 'Open analytics', href: '/analytics' }],
      },
    ],
  },
];

export const ALL_LESSONS = TRACKS.flatMap((t) => t.lessons.map((l) => ({ ...l, trackId: t.id })));
export const lessonById = (id: string) => ALL_LESSONS.find((l) => l.id === id) ?? null;
export const trackById = (id: string) => TRACKS.find((t) => t.id === id) ?? null;
