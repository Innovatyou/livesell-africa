/**
 * Terms of Service and Privacy Policy. Versions must match apps/api/src/legal/versions.ts — registrations record
 * which version was accepted. Company identity comes from env so nothing about the legal entity is invented:
 *   NEXT_PUBLIC_LEGAL_ENTITY_NAME   registered company name (defaults to "LiveSell Africa")
 *   NEXT_PUBLIC_LEGAL_ADDRESS       registered address (optional)
 *   NEXT_PUBLIC_SUPPORT_EMAIL       support contact (optional; otherwise the contact page)
 *   NEXT_PUBLIC_PRIVACY_EMAIL       data protection contact (optional; otherwise the contact page)
 */
export const TERMS_VERSION = '2026-11-05';
export const PRIVACY_VERSION = '2026-11-05';
export const LEGAL_EFFECTIVE_DATE = '5 November 2026';

export const COMPANY = {
  name: process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME || 'LiveSell Africa',
  address: process.env.NEXT_PUBLIC_LEGAL_ADDRESS || null,
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || null,
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL || null,
};

export type Block = string | { list: string[] } | { contact: 'support' | 'privacy' };
export interface Section { id: string; title: string; body: Block[] }
export interface LegalDoc { title: string; version: string; intro: string[]; sections: Section[] }

const L = COMPANY.name;

export const TERMS: LegalDoc = {
  title: 'Terms of Service',
  version: TERMS_VERSION,
  intro: [
    `These Terms of Service (the “Terms”) are an agreement between you and ${L} (“LiveSell”, “we”, “us”) and govern your use of the LiveSell Africa platform, including the dashboard, storefronts, APIs and related services (the “Services”).`,
    'By creating an account, accepting an invitation to a store, or using the Services, you agree to these Terms and to our Privacy Policy. If you use LiveSell on behalf of a business, you confirm that you are authorised to bind that business, and “you” includes the business.',
  ],
  sections: [
    {
      id: 'definitions', title: '1. Definitions',
      body: [{ list: [
        '“Seller” means the person or business that registers a store on LiveSell and is responsible for it.',
        '“Staff user” means a person a Seller invites to help run their store (for example a store manager, sales assistant or live moderator).',
        '“Customer” means a person who buys, or asks to buy, from a Seller through the Services.',
        '“Verified sale” means a customer payment for an order that has been confirmed by the payment provider through server-side verification or a signed notification, or that the Seller has manually confirmed for a bank transfer.',
        '“Content” means anything you upload or enter, including product details, images, logos, descriptions and messages.',
      ] }],
    },
    {
      id: 'accounts', title: '2. Your account',
      body: [{ list: [
        'You must be at least 18 years old and able to enter into a binding contract under Nigerian law.',
        'You must give accurate, current information, including your business details, and keep it up to date.',
        'Keep your password confidential. You are responsible for activity on your account and for the actions of Staff users you invite. Tell us immediately if you suspect unauthorised access.',
        'We may ask you to verify your email address and phone number. Business verification is optional; a verified badge only means we reviewed the registration documents you submitted, not that we endorse your business.',
        'Store usernames are first come, first served. We may reclaim a username that impersonates another person or brand, or that misleads customers.',
      ] }],
    },
    {
      id: 'services', title: '3. The Services',
      body: [
        'LiveSell provides tools to run a social-commerce business: storefronts, product and order management, live-selling tools, customer records, notifications, payment integrations and reporting. We release features in stages; features described as “coming soon” are not yet part of the Services.',
        'We may improve, change or discontinue features. If we remove a feature that is material to your paid plan, we will tell you in advance and, where appropriate, offer a pro-rata credit.',
      ],
    },
    {
      id: 'pricing', title: '4. Pricing options, trials and fees',
      body: [
        'You can pay for LiveSell in one of two ways, as shown on our pricing page when you choose:',
        { list: [
          'Subscription: a fixed monthly or annual fee for your chosen plan, with no LiveSell commission on your sales unless a different arrangement is agreed with you in writing.',
          'Pay as you sell (commission-based): no fixed fee. Instead you pay LiveSell a commission equal to the percentage shown for that option of the amount the Customer actually paid for each Verified sale. Commission is calculated in kobo and rounded down, and is not charged on amounts refunded to the Customer.',
        ] },
        'Free trial. New stores start with a free trial (currently 14 days). No fees or commission are charged during the trial. At the end of the trial your chosen option starts automatically unless you cancel.',
        'Billing. Subscription fees are invoiced at the start of each billing period. Commission is deducted from the payment at settlement where the payment provider supports split settlement; otherwise it is invoiced to you monthly in arrears. Prices are in Naira unless stated otherwise. Taxes, including VAT, are added where required by law and shown on your invoice.',
        'Changing plans. Upgrades take effect once any amount due is paid and are charged pro rata for the rest of the current period. Downgrades and moves from a subscription to the commission option take effect at the end of the current period. You can move from the commission option to a subscription at any time.',
        'Late payment. If a subscription invoice is unpaid when due, you keep full access for a grace period (currently 3 days). After that your store becomes read-only: you can still see your data and pay, but you cannot make changes until the invoice is paid.',
        'Cancellation and refunds. You can cancel at any time from Plan & billing; cancellation takes effect at the end of the current period. Fees already paid are not refundable for partial periods except where the law requires otherwise.',
        'Price changes. We will give you at least 30 days’ notice of any increase in subscription fees or commission rates. Changes apply from your next billing period, and you may cancel before they take effect.',
      ],
    },
    {
      id: 'payments', title: '5. Customer payments',
      body: [
        'LiveSell is not a bank, a payment service provider or a party to your sales. Customer payments are processed by third-party providers (such as Paystack, Flutterwave and Bachs) or by direct bank transfer, under those providers’ own terms, which you must accept separately. Where you connect your own provider account, funds settle to you directly under that provider’s settlement terms.',
        'We mark an order as paid only after the payment provider confirms it through server-side verification or a signed notification. We never treat a payment redirect, a screenshot or a customer’s claim as proof of payment. For bank transfers you are responsible for checking that the money has arrived before confirming a payment.',
        'You are responsible for refunds, chargebacks and disputes with your Customers. We keep transaction records to help with reconciliation but do not guarantee any provider’s availability, fees or settlement times.',
      ],
    },
    {
      id: 'seller-duties', title: '6. Your responsibilities as a Seller',
      body: [{ list: [
        'Sell only goods and services you are legally allowed to sell, and describe them, their prices and any delivery fees accurately.',
        'Honour your obligations to Customers, including delivery, returns and refunds, in line with the Federal Competition and Consumer Protection Act 2018 and other applicable law.',
        'Hold any licences, registrations or approvals your products need (for example NAFDAC registration for regulated food, drugs and cosmetics).',
        'Keep proper records and pay the taxes that apply to your sales.',
        'Use Customer personal data only to fulfil orders and communicate as the Customer expects, and comply with the Nigeria Data Protection Act 2023 (see section 10).',
      ] }],
    },
    {
      id: 'acceptable-use', title: '7. Prohibited items and conduct',
      body: [
        'You must not use LiveSell to sell, promote or facilitate:',
        { list: [
          'Illegal goods or services, stolen goods, or counterfeit or infringing products.',
          'Firearms, ammunition, explosives, illegal drugs, or prescription medicines without the required authorisation.',
          'Sexually explicit material, or anything that exploits or harms children.',
          'Pyramid or Ponzi schemes, fraudulent offers, or misleading claims.',
        ] },
        'You must not: send spam or messages to people who have not opted in; impersonate others; try to access other sellers’ data; probe, scan or test our systems without written permission; scrape the Services; reverse-engineer them except where the law allows; or bypass plan limits or security controls.',
      ],
    },
    {
      id: 'third-parties', title: '8. Social platforms and messaging',
      body: [
        'TikTok, Instagram, Facebook, YouTube, WhatsApp and similar platforms are operated by third parties. We integrate with them only through their official APIs and permissions, and features depend on what those platforms make available. You must follow their terms and policies when you sell on them.',
        'When LiveSell sends WhatsApp, SMS or email messages on your behalf, you confirm that the Customer has given any consent the law or the platform requires, and you must honour opt-outs. Messaging may be charged as shown in your account.',
      ],
    },
    {
      id: 'content', title: '9. Content and intellectual property',
      body: [
        'You keep ownership of your Content. You grant LiveSell a worldwide, non-exclusive, royalty-free licence to host, store, copy, display and transmit your Content only as needed to provide and promote your store through the Services. This licence ends when you delete the Content or close your store, except for backups kept for a limited period and copies we must keep by law.',
        'You confirm you have the rights to your Content and that it does not infringe anyone else’s rights. LiveSell and its licensors own the Services, software, design and brand. If you send us feedback, we may use it without obligation to you.',
      ],
    },
    {
      id: 'data', title: '10. Data protection',
      body: [
        'Our Privacy Policy explains how we handle personal data about you and your Staff users; for that data, LiveSell is the data controller.',
        'For personal data about your Customers that you collect or manage through LiveSell, you are the data controller and LiveSell acts as your data processor. As your processor we will: process that data only to provide the Services and on your documented instructions; keep it confidential and secure; use sub-processors only under written obligations at least as protective as these; help you respond to data subject requests; tell you without undue delay after becoming aware of a personal data breach affecting it; and delete or return it when you close your store, unless the law requires us to keep it.',
      ],
    },
    {
      id: 'availability', title: '11. Availability and support',
      body: ['We work to keep the Services available and secure, but they are provided on an “as is” and “as available” basis. Planned maintenance will be announced where practical. Support is provided through your account and the contact options below.'],
    },
    {
      id: 'termination', title: '12. Suspension and termination',
      body: [
        'You can close your store at any time. We may suspend or close an account, with notice where reasonable, if you materially breach these Terms, fail to pay amounts due after the grace period, put Customers or other sellers at risk, or if we are required to by law or by a payment or platform provider.',
        'When an account is closed, access ends. Unless the law prevents it, we will give you a reasonable opportunity to retrieve your data first. Records we must keep by law (for example financial and audit records) are retained as described in the Privacy Policy. Sections that by their nature should survive termination (including fees owed, intellectual property, liability and governing law) continue to apply.',
      ],
    },
    {
      id: 'liability', title: '13. Disclaimers and limitation of liability',
      body: [
        'To the extent permitted by law, we exclude all implied warranties, including that the Services will be uninterrupted or error-free, or that any sales volume will be achieved.',
        'To the extent permitted by law, neither party is liable for indirect or consequential losses, or for loss of profit, revenue, goodwill or data, and each party’s total liability arising out of these Terms in any 12-month period is limited to the total fees and commission you paid to LiveSell in that period. Nothing in these Terms limits liability for fraud, for death or personal injury caused by negligence, or for anything else that cannot be limited by law.',
      ],
    },
    {
      id: 'indemnity', title: '14. Indemnity',
      body: ['You will indemnify LiveSell against claims by third parties (including Customers and regulators) arising from your products, your Content, your dealings with Customers, or your breach of these Terms or the law.'],
    },
    {
      id: 'changes', title: '15. Changes to these Terms',
      body: ['We may update these Terms. For material changes we will give at least 30 days’ notice by email or in your dashboard. Continuing to use the Services after the change takes effect means you accept the updated Terms. Each version is dated and we record which version you accepted.'],
    },
    {
      id: 'law', title: '16. Governing law and disputes',
      body: [
        'These Terms are governed by the laws of the Federal Republic of Nigeria.',
        'If a dispute arises, the parties will first try in good faith to resolve it through negotiation for 30 days. If it is not resolved, it will be referred to arbitration under the Arbitration and Mediation Act 2023, seated in Lagos, before a sole arbitrator, conducted in English. Either party may still seek urgent injunctive relief from the courts of Lagos State. Nothing here limits rights you have as a consumer that cannot be waived.',
      ],
    },
    { id: 'contact', title: '17. Contact', body: [{ contact: 'support' }] },
  ],
};

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  version: PRIVACY_VERSION,
  intro: [
    `This Privacy Policy explains how ${L} (“LiveSell”, “we”, “us”) collects and uses personal data when you visit our website, create or use a seller account, join a store as a staff member, or contact us. It is written to meet the Nigeria Data Protection Act 2023 (“NDPA”) and the regulations and guidance of the Nigeria Data Protection Commission (“NDPC”).`,
    'For personal data about you and your staff, LiveSell is the data controller. For personal data about a seller’s customers (for example names, phone numbers and delivery addresses entered for orders), the seller is the controller and LiveSell processes that data on the seller’s behalf. If you are a customer of a seller, please contact that seller first about your data; we will help them respond.',
  ],
  sections: [
    {
      id: 'collect', title: '1. What we collect',
      body: [{ list: [
        'Account details: your name, email address, phone number, and a securely hashed password (we never store your password itself).',
        'Business details: business name, type and category, address, state and city, store username, logo, store description, contact details and social media handles.',
        'Verification information: email and phone verification status and, if you choose to verify your business, your registered business name, CAC registration number and the certificate you upload.',
        'Team information: email addresses of people you invite and their roles.',
        'Billing information: your plan or pricing option, invoices and payment status. Card details are entered with our payment providers; LiveSell never receives or stores full card numbers or CVV codes.',
        'Store data you manage: products, orders, customers, payments and messages you create or receive through LiveSell.',
        'Technical and security data: IP address, browser type, and a log of security-relevant actions (such as sign-ins, password changes and payment confirmations).',
        'Communications: messages you send us, including enquiries through our Contact sales form.',
      ] }],
    },
    {
      id: 'use', title: '2. How we use it and our lawful bases',
      body: [{ list: [
        'To create and run your account and store, provide the features you use, and take payment for your plan — performance of our contract with you.',
        'To verify your email, phone and (if you choose) your business, and to keep accounts secure, prevent fraud and investigate misuse — our legitimate interests in a safe platform, and your consent where you submit optional verification.',
        'To send service messages such as verification codes, invitations, invoices, renewal reminders and security alerts — performance of contract.',
        'To keep financial, tax and audit records and respond to lawful requests — compliance with legal obligations.',
        'To improve LiveSell using aggregated, de-identified usage information — our legitimate interests.',
        'To reply to sales enquiries and, if you agree, send product news — legitimate interests or consent. You can opt out of marketing at any time.',
      ] }],
    },
    {
      id: 'cookies', title: '3. Cookies and similar technologies',
      body: [
        'We use one essential cookie to keep you signed in securely (a session refresh cookie that scripts on the page cannot read). We store the store you last selected in your browser’s local storage so the dashboard opens in the right place. We do not use advertising or cross-site tracking cookies. Blocking the essential cookie will stop you from staying signed in.',
      ],
    },
    {
      id: 'share', title: '4. Who we share it with',
      body: [
        'We do not sell personal data. We share it only with:',
        { list: [
          'Service providers who host and operate LiveSell for us, such as cloud hosting, file storage (for example Cloudflare or Amazon Web Services), email, SMS and WhatsApp delivery, and error monitoring — under contracts that require them to protect it and use it only on our instructions.',
          'Payment providers you or your customers choose (such as Paystack, Flutterwave and Bachs) to process payments and subscriptions.',
          'Messaging platforms such as WhatsApp (Meta) when messages are sent on a seller’s behalf.',
          'Authorities, courts or regulators where the law requires it, or to protect the rights, safety and security of our users and LiveSell.',
          'A buyer or successor if LiveSell is reorganised, merged or sold, subject to this Policy.',
        ] },
      ],
    },
    {
      id: 'transfers', title: '5. International transfers',
      body: ['Some of our providers process data outside Nigeria. Where they do, we transfer data only as permitted by Part VIII of the NDPA — for example to countries with adequate protection, or under contractual safeguards approved or recognised by the NDPC.'],
    },
    {
      id: 'retention', title: '6. How long we keep it',
      body: [{ list: [
        'Account and store data: for as long as your account is open. After closure, records we must keep for tax, accounting and legal purposes (including invoices, transactions and audit logs) are kept for as long as Nigerian law requires, generally six years; other data is deleted or anonymised within a reasonable period.',
        'Verification codes and links: they expire within minutes or hours and are stored only in protected (hashed) form.',
        'Business verification documents: while your business is verified and for the statutory period afterwards.',
        'Security and audit logs: kept in tamper-resistant form for as long as needed to protect accounts and meet legal obligations.',
        'Sales enquiries: up to 24 months after our last contact, unless you become a customer.',
      ] }],
    },
    {
      id: 'security', title: '7. How we protect it',
      body: ['We use encryption in transit (HTTPS), strong password hashing, encryption of sensitive fields such as bank account numbers and payment gateway keys, strict separation of each seller’s data, role-based access for staff, single-use time-limited verification links and codes, and audit logging. No system is perfectly secure; if a breach affects your personal data we will notify you and the NDPC as the law requires.'],
    },
    {
      id: 'rights', title: '8. Your rights',
      body: [
        'Under the NDPA you have the right to: be informed about how your data is used; access your data; have inaccurate data corrected; have data deleted where there is no legal reason to keep it; restrict or object to certain processing; receive your data in a portable format; withdraw consent at any time (without affecting processing already done); and not be subject to decisions based solely on automated processing that significantly affect you.',
        'You can update most details yourself in your account. For anything else, contact us using the details below. We may need to confirm your identity before acting, and we will respond within the time the law requires.',
        'If you are not satisfied with our response, you can complain to the Nigeria Data Protection Commission (ndpc.gov.ng).',
      ],
    },
    {
      id: 'children', title: '9. Children',
      body: ['LiveSell is for businesses and is not directed at anyone under 18. We do not knowingly collect personal data from children.'],
    },
    {
      id: 'changes', title: '10. Changes to this Policy',
      body: ['We will post any changes here with a new version date and, for material changes, tell you by email or in your dashboard before they take effect.'],
    },
    { id: 'contact', title: '11. Contact us', body: [{ contact: 'privacy' }] },
  ],
};
