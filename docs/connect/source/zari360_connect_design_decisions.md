# Zari360 Connect — Design Decisions Doc

**Purpose:** Lock the merged design system before producing any more wireframes. This doc codifies what we keep from Set 1 (industry adaptation), what we keep from Set 2 (polish, density, structure), and the rules every future screen inherits.

**Status:** v1 — to be reviewed and locked. Once locked, every wireframe, every Figma file, every engineering ticket references this.

**Owner:** Product (you) · Design partner · Engineering lead

---

## 0. How to read this doc

Each section answers one question:

- What's the rule?
- Why this rule (and not the alternative)?
- What does it look like in practice?

When designers and engineers disagree, this doc is the tiebreaker. If a situation isn't covered here, add it — don't guess.

---

## 1. Merged design system — what we keep from each set

### 1.1 From Set 1 (industry adaptation layer)

These must appear in every relevant screen. They are the moat made visible.

| Element                                                                                           | Where it appears                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **ERP-linked badge** (dark navy pill, prominent)                                                  | Profile, Company Page, Product card, Candidate card, Feed post header, Search result, Inbox thread header |
| **"Verified by Zari360 ERP" trust panel** with explanation                                        | Profile right rail, Company Page right rail, Product detail right rail                                    |
| **Voice-note application / posting / messaging**                                                  | Job application form, Feed composer, Inbox composer                                                       |
| **WhatsApp-first CTA** on every relevant card                                                     | Job card, Product card, Candidate card, Inquiry, Inbox header                                             |
| **Translate inline** option on multilingual posts                                                 | Feed post header, Inquiry thread, Product description                                                     |
| **Daily-wage / piece-rate / monthly** as first-class job types                                    | Job filters, Job card, Job detail, Profile rate-card row                                                  |
| **From Your ERP card** ("17 active karigars, ₹4.49L payroll — your factory is visible to buyers") | Feed left rail, Workspace owner home, Onboarding nudge                                                    |
| **Karigars Near You sidebar**                                                                     | Feed right rail, Marketplace right rail, Job employer Candidates tab                                      |
| **Live RFQs sidebar / RFQ Board**                                                                 | Marketplace right rail (mini-widget) + dedicated RFQ Board sub-tab                                        |
| **Lead Manager mini-widget** (8 new / 3 quoted / 2 negotiating / 1 won)                           | Marketplace right rail (seller view), Storefront page                                                     |
| **"Open to custom orders" / "Open to deals"** status (separate from "Open to work")               | Profile header, search filters, Company Page header                                                       |
| **Reviews unlocked only after both parties confirm deal**                                         | Product detail, Profile, Company Page — show explanation inline                                           |

### 1.2 From Set 2 (chrome and density layer)

These are the structural patterns. Every page inherits these.

| Pattern                                                                                                 | Rule                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tabbed sub-pages within a module**                                                                    | Jobs = Find Jobs / My Applications / Posted Jobs / Candidates. Network = Invitations / Connections / Following / Suggestions. Marketplace = Browse / My Leads / RFQ Board. One URL per module, tabs swap content. |
| **Profile-strength card with actionable checklist**                                                     | Right rail of Profile and Feed home. Lists exactly what's missing, with Add/Ask CTAs inline. Not just a percentage.                                                                                               |
| **"Private to you" label on personal analytics**                                                        | Profile views, Search appearances, Post impressions — always labeled to build trust.                                                                                                                              |
| **Premium-feature gentle hooks**                                                                        | "See exactly who viewed your profile — a Connect Premium feature" pattern. Native, not a popup.                                                                                                                   |
| **Pipeline/ATS view inside Posted Jobs**                                                                | Applied → Screened → Interviewed → Offered → Hired columns. Drag-and-drop later; click-to-move v1.                                                                                                                |
| **Caller ID with intent banner** on Candidates tab                                                      | Explains the feature inline before user uses it.                                                                                                                                                                  |
| **Pinned context bar** in Inbox threads                                                                 | Shows what listing / job / page the thread is about. Persists across all messages in the thread.                                                                                                                  |
| **Horizontal category bar** on Marketplace top                                                          | Scrollable, sticky. Above the filter rail.                                                                                                                                                                        |
| **Industry details panel** on Company Page (Specialization / Machine capacity / Production / Languages) | Embroidery-specific structured data. Locked as a required section.                                                                                                                                                |
| **Pinned case study** on Company Page                                                                   | Admin-pinned post with delivery metrics (e.g. 480 sarees / 11 days / 0 reworked).                                                                                                                                 |
| **People-also-viewed sidebar**                                                                          | Profile and Product detail right rails.                                                                                                                                                                           |
| **Trending in embroidery** hashtag sidebar                                                              | Feed right rail. Surat-specific filter.                                                                                                                                                                           |

### 1.3 Where the two sets conflicted — decisions

| Conflict                                                                                                 | Decision                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set 1 had a single Network view; Set 2 had tabs                                                          | **Set 2 wins.** Tabs (Invitations / Connections / Following / Suggestions).                                                                         |
| Set 1 split Jobs into separate URLs; Set 2 used tabs                                                     | **Set 2 wins.** One Jobs URL, four tabs (role-aware).                                                                                               |
| Set 1's Marketplace had 3 products per row; Set 2 had 4                                                  | **Set 2 wins on desktop (4 across).** Tablet 3, mobile 2.                                                                                           |
| Set 1 had explicit annotations on every screen; Set 2 was clean                                          | **Hybrid.** Wireframes (Figma/inline) keep annotations for design review. Production builds remove them. PRD doc holds the annotations permanently. |
| Set 1 had "Lead Manager" on right rail; Set 2 dropped it                                                 | **Set 1 wins.** Reinstate. Sellers need lead-pipeline visibility front-and-center.                                                                  |
| Set 1's Profile had daily-wage / piece-rate stat boxes on header; Set 2 buried them in Industry Snapshot | **Hybrid.** Keep Industry Snapshot section, but surface 2–3 key stats (rate, response time, ERP-status) in the header for at-a-glance.              |
| Set 1 had Voice Note application; Set 2 removed it                                                       | **Set 1 wins.** Reinstate everywhere voice helps low-literacy users.                                                                                |
| Set 1 had Apply via WhatsApp on Job Detail; Set 2 removed it                                             | **Set 1 wins.** Reinstate as a secondary CTA below Send Application.                                                                                |

---

## 2. Verb taxonomy (locked)

Inconsistent CTAs is the #1 design problem in B2B platforms. Lock this and never deviate.

### 2.1 The verb table

| Action                                     | Verb                                               | Where it appears                                      | Color tier            |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------- | --------------------- |
| Buyer → Seller, asking for price           | **Get quotation**                                  | Product card, Marketplace listings                    | Primary               |
| Buyer → Seller, inside product detail page | **Send inquiry**                                   | Product detail page CTA                               | Primary               |
| Buyer → Seller, posting open RFQ           | **Post an RFQ**                                    | Marketplace top, RFQ Board                            | Secondary             |
| Seller → Buyer, responding to RFQ          | **Send quote**                                     | RFQ board responses, Lead Manager                     | Primary               |
| Candidate → Employer                       | **Apply**                                          | Job cards, Job detail                                 | Primary               |
| Candidate → Employer, via WhatsApp         | **Apply via WhatsApp**                             | Job detail (secondary CTA)                            | Secondary             |
| Candidate → Employer, via voice            | **Record voice note instead**                      | Job detail (text link)                                | Tertiary              |
| Employer → Candidate, direct outreach      | **Invite to apply**                                | Candidates tab, Profile of karigar                    | Primary               |
| Person → Person, symmetric                 | **Connect**                                        | People cards, search results                          | Primary               |
| Person → Company Page, asymmetric          | **Follow**                                         | Company Page, suggestion cards                        | Primary               |
| Either party, real-time chat               | **Message**                                        | Inbox, profiles, company pages                        | Secondary             |
| Either party, off-platform escalation      | **Continue on WhatsApp** / **Message on WhatsApp** | After inquiry sent, top of inbox thread, Company Page | Green WhatsApp button |
| Save for later                             | **Save**                                           | All cards                                             | Icon only (bookmark)  |
| Request a written endorsement              | **Ask for recommendation**                         | Profile editor, Profile strength checklist            | Secondary             |
| Recommend somebody you've worked with      | **Endorse** / **Write a recommendation**           | Skills section / Profile of connection                | Secondary             |
| Pin content on a page you admin            | **Pin to top**                                     | Company Page admin view, Profile owner view           | Tertiary (menu)       |
| Move candidate through pipeline            | **Move to [stage]**                                | Posted Jobs pipeline                                  | Tertiary (menu)       |

### 2.2 Rules

- **Never use "Buy"** — we're lead-gen, never transactional.
- **Never use "Hire"** as a button — it's a multi-step process; use "Move to Offered" / "Move to Hired" inside the pipeline.
- **Never use "Apply" for marketplace** — that's job vocabulary.
- **Never use "Contact"** — too vague. Pick Message, Call, or WhatsApp explicitly.
- **WhatsApp CTA is always green** (`#25D366` brand color or visually distinct from primary).

---

## 3. Badge hierarchy (locked)

Trust signals must be readable in a glance. Badges have an order, a color, and a meaning.

### 3.1 Tier table

| Tier                | Badge                                                                                 | Color                                          | Earned by                                                                                              | Where it appears                          |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Tier 0 (moat)**   | **ERP-linked**                                                                        | Dark navy pill, white text (e.g. `#1B2A5E` bg) | Workspace has active Zari360 ERP usage (attendance, payroll, machines actively logged in past 30 days) | All entity headers, search results, cards |
| **Tier 1**          | **GST verified**                                                                      | Green pill, white text                         | GSTIN successfully validated via official GST API                                                      | Same as above                             |
| **Tier 1**          | **Udyam verified**                                                                    | Blue/teal pill                                 | Udyam registration validated                                                                           | Profile + Company Page                    |
| **Tier 2**          | **Mobile verified**                                                                   | Light gray pill or checkmark                   | OTP completed                                                                                          | Profile only (don't clutter cards)        |
| **Tier 2**          | **Email verified**                                                                    | Light gray pill or checkmark                   | Email confirmed                                                                                        | Profile only                              |
| **Tier 3 (status)** | **Open to work** / **Open to hiring** / **Open to deals** / **Open to custom orders** | Soft amber/cream pill                          | User-toggled                                                                                           | Profile header, Company Page header       |

### 3.2 Display rules

- **Maximum 3 badges visible on any card.** Show ERP-linked first, then GST, then one more if relevant. Hide rest behind a "+2 more" tap.
- **On Profile / Company Page headers**, show all earned badges in a single row.
- **ERP-linked is always shown if earned** — it's the moat. Cannot be hidden.
- **Profile and Company Page must explain what ERP-linked means** via a right-rail trust panel: "This profile is backed by real operational data — active workspace, attendance, payroll. Not just a self-claim."
- **No fake or aspirational badges.** "Top karigar" / "Trusted seller" — these are gamification and erode trust. We don't ship them in v1.

---

## 4. Layout rules

### 4.1 Page structure (desktop, ≥1280px)

Every Connect page uses one of three layouts:

**Layout A — Three-column (Feed, Profile, Company Page, Marketplace home)**

- Left rail: 240px — primary navigation (when collapsed) or contextual sidebar (profile card, quick links)
- Center: flex — main content
- Right rail: 320px — discovery, analytics, trust signals, sidebars
- Gutters: 24px between columns

**Layout B — Two-column (Inbox, Network, Jobs, Companies list)**

- Left rail: 280px — list / filter
- Center: flex — selected item detail
- No right rail (right rail content folds into the detail)

**Layout C — Single-column (Onboarding, post composer, full-screen modals)**

- Centered, max-width 720px
- No rails

### 4.2 Tablet (768–1279px)

- Right rail collapses to a floating panel or moves below content
- Left rail stays
- Card grids reduce by one column (4→3 in Marketplace, 3→2 in suggestions)

### 4.3 Mobile (<768px)

- All rails collapse. Bottom tab bar replaces the left module switcher.
- Single column. Cards are full-width.
- Bottom tabs: **Home / Network / Marketplace / Inbox / You (profile + workspace switcher)** — 5 tabs max.
- Jobs is reached via a top FAB on Home, or a banner ("3 new jobs match your profile") — saves a tab slot.
- This is non-negotiable: Surat embroidery is mobile-first.

### 4.4 Spacing system

| Token     | Value | Use                            |
| --------- | ----- | ------------------------------ |
| `space-1` | 4px   | Within icon+text pairs         |
| `space-2` | 8px   | Between related elements       |
| `space-3` | 16px  | Card internal padding          |
| `space-4` | 24px  | Between cards, section gutters |
| `space-5` | 32px  | Between major sections         |
| `space-6` | 48px  | Above section headers          |

### 4.5 Typography

Use AntD's default scale (we already locked AntD as the design system). Specifically:

| Use                 | Size    | Weight           |
| ------------------- | ------- | ---------------- |
| Page title (H1)     | 28–32px | 600              |
| Section header (H2) | 20–22px | 600              |
| Card title          | 16–18px | 600              |
| Body                | 14px    | 400              |
| Secondary           | 13px    | 400, muted color |
| Caption / metadata  | 12px    | 400, muted color |

Multilingual content: same scale; allow line-height to expand for Gujarati and Hindi which have taller glyphs.

---

## 5. Empty-state pattern (locked)

Every screen must have a designed empty state. Empty means: zero of the thing the screen lists.

### 5.1 The empty-state recipe

Every empty state has exactly these elements:

1. **Illustration or icon** — a single decorative element, not a wall of art. AntD icon set or a custom monochrome SVG.
2. **Headline** — one sentence, in user's language, telling them what's missing. Not "No data" or "Nothing here." Always specific: "You haven't applied to any jobs yet."
3. **Subhead** — one sentence telling them why they'd want to fix this. "Browse 128 open positions in Surat to get started."
4. **Primary CTA** — the most likely next action. "Find jobs" / "Complete your profile" / "Post your first product."
5. **Secondary action (optional)** — for users who aren't ready: "Learn how Connect works" / "Watch a 60-second tour."

### 5.2 Empty states required (page → empty state)

| Page                              | Empty headline                                                                | CTA                    |
| --------------------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| Feed (0 follows, 0 connections)   | Your feed is quiet. Follow workshops and connect with karigars to fill it.    | Find people in Surat   |
| Profile (0 portfolio)             | Add work samples — buyers and recruiters look at these first.                 | Add a work sample      |
| Profile (0 skills)                | What kind of embroidery do you do? Add 3 skills so people can find you.       | Add skills             |
| Network — Invitations (0)         | No pending invitations.                                                       | Find people to connect |
| Network — Connections (0)         | You haven't connected with anyone yet.                                        | See suggestions        |
| Network — Following (0)           | Follow workshops to see their posts and openings.                             | Discover workshops     |
| Inbox (0 threads)                 | No messages yet. Inquiries, job applications, and DMs will arrive here.       | Browse marketplace     |
| Marketplace — My Leads (0)        | Inquiries you send and receive land here.                                     | Browse products        |
| Marketplace — RFQ Board (0)       | No open RFQs match your categories right now. Post your own to invite quotes. | Post an RFQ            |
| Jobs — My Applications (0)        | You haven't applied to any jobs.                                              | Find Jobs              |
| Jobs — Posted Jobs (0, employer)  | Post your first job — search 86 karigars and designers in Surat.              | Post a job             |
| Jobs — Candidates (0 in pipeline) | No candidates yet. Invite karigars directly or wait for applications.         | Browse karigars        |
| Storefront (0 products, seller)   | Add your first product. Buyers find suppliers via product searches.           | Add product            |
| Company Page (0 posts)            | Share an update or pin a case study. Followers will see it in their feed.     | Create a post          |
| Notifications (0)                 | All caught up. New activity will appear here.                                 | —                      |
| Search (0 results)                | No results for "[query]." Try a broader keyword or check spelling.            | Clear filters          |

### 5.3 First-day persona — the day-1 karigar

Every empty state must be designed for **a 22-year-old daily-wage karigar with one phone photo and zero everything**. If your empty state assumes the user already understands what Connect is, redesign it.

---

## 6. Mobile-specific rules

Surat embroidery is mobile-first. Desktop is the second-screen experience.

### 6.1 Bottom tab bar — locked

Five tabs, no more:

1. **Home** (Feed)
2. **Network**
3. **Marketplace**
4. **Inbox**
5. **You** (Profile + Workspace switcher + Settings)

Jobs is reached via:

- A persistent banner at the top of Home: "[N] new jobs match you →"
- A FAB ("+") on Home if user is an employer with Posted Jobs
- A link in the You tab

### 6.2 Mobile cards

- All cards full-width (`100% - 16px` gutters).
- Tap target minimum 44×44px.
- Avatars 40px on cards, 64px on detail pages.
- Images 16:9 hero, square thumbnails.
- WhatsApp button is sticky-bottom on long pages (Product Detail, Job Detail, Profile).

### 6.3 Mobile composer

- Composer opens as a full-screen sheet, not a modal.
- Top-right: post-as selector (You vs Company Page).
- Bottom toolbar: photo / video / voice / document / job-tag / product-tag.
- Voice button is large, with a "tap to record" / "release to send" gesture.

### 6.4 Mobile search

- Search bar pinned at top of Home, Network, Marketplace, Jobs.
- Tapping opens a full-screen search with recent + saved + suggested categories.
- Voice search button inside the input.

---

## 7. Voice and low-literacy paths (locked)

These exist because not every user can read or type Gujarati/Hindi/English. Voice is not an accessibility add-on; it's a primary path.

| Surface         | Voice support                                                   |
| --------------- | --------------------------------------------------------------- |
| Feed composer   | "Record voice note" as first-class option alongside photo/video |
| Job application | "Record voice note instead of cover note"                       |
| Inbox           | Send voice note from composer                                   |
| Search          | Voice search button in every search input                       |
| Reviews         | Record video review (Phase 4+) or voice review                  |

**Rules:**

- Voice notes have a visible waveform after recording.
- Voice notes always show duration (e.g. 0:24).
- Voice notes have a "Transcribe (auto, beta)" option for users on the other end. This addresses the "I'm in a meeting and can't play audio" case.
- Voice search converts to text before submitting — text is shown to user to confirm.

---

## 8. WhatsApp handoff pattern (locked)

WhatsApp is how Surat closes deals. We capture the lead on-platform, we hand off cleanly.

### 8.1 Where the handoff appears

- After an inquiry is sent (Marketplace) — "Continue on WhatsApp" button appears with pre-filled context.
- After a job application — "Apply via WhatsApp" sends profile snapshot to employer's WhatsApp.
- On every Inbox thread — "WhatsApp" button at top, opens chat with thread context.
- On every Company Page — "Message on WhatsApp" as primary CTA option.

### 8.2 What gets pre-filled

When user taps "Continue on WhatsApp":

```
Hi [Seller Name],
I sent an inquiry on Zari360 Connect about [Product Name] —
quantity [N], target price [₹X], delivery [date].
Can we discuss here?

— [Buyer Name] (via Zari360 Connect)
```

The "via Zari360 Connect" footer trains the network to recognize where the lead came from. This is brand-building free.

### 8.3 What does NOT happen on WhatsApp handoff

- We do not record WhatsApp messages. Privacy.
- We do not auto-sync WhatsApp threads. Privacy.
- We do not store the seller's WhatsApp number in the buyer's contacts. The user copies it manually or taps the deep link.

---

## 9. The "ERP-linked" moat — display rules

This is the single most important design decision. Repeat consistently.

### 9.1 What earns ERP-linked

A workspace becomes ERP-linked when, in the last 30 days, the ERP has logged at least:

- 5 attendance entries, OR
- 1 payroll run, OR
- 3 invoices/expenses

Status decays after 60 days of inactivity (silent — no penalty, just no badge).

### 9.2 Where ERP-linked appears

- On every profile of a person whose primary workspace is ERP-linked.
- On the workspace's Company Page.
- On every product the workspace lists.
- On every job the workspace posts.
- On the candidate card if the karigar's current workspace is ERP-linked.

### 9.3 The trust panel

On Profile / Company Page / Product detail, a panel labeled **"ERP-linked · Moat signal"** appears in the right rail with text like:

> This profile is backed by real operational data — active workspace, attendance, payroll. Not a self-claim.
>
> ERP active since [date] · [N] karigars on roll

This panel exists because the badge alone doesn't explain itself. New users won't know what "ERP-linked" means; the panel teaches them.

### 9.4 The "From your ERP" callout (workspace owner view)

On the Feed left rail (and Onboarding home for owners), show:

> **From your ERP**
> [N] active karigars · ₹[X] payroll this month
> Your factory's track record is visible to buyers.
> [Open ERP → Dashboard]

This closes the loop — the owner sees that ERP usage isn't just internal admin work; it's their marketing.

---

## 10. Marketplace-specific rules

### 10.1 No cart, no checkout (locked)

Repeat in every onboarding nudge, every marketplace banner: "Lead-gen, not transactional. Deals close on call or WhatsApp."

### 10.2 Phone reveal economics

- Buyer's phone is hidden until seller accepts the inquiry.
- Seller's phone is hidden until both parties have engaged once.
- Phase 5: free reveals capped at 5/month per user. Premium: unlimited.

### 10.3 RFQ Board (reverse listings)

- Buyers post RFQs freely (no cost in v1).
- Sellers see RFQs matched to their categories.
- Sellers respond with "Send quote" — pre-filled with their listing details + price.
- Phase 5: sellers pay for unlimited RFQ responses; free tier sees 3 RFQs/week.

### 10.4 Lead Manager (seller-side CRM)

Required widget. Without it, sellers will use WhatsApp and lose attribution.

Tabs: **New · Quoted · Negotiating · Won · Lost**

Each lead row: buyer name, product, inquiry date, last action, status pill, "Add note" + "Continue on WhatsApp" actions.

### 10.5 Bulk pricing table (reinstated from Set 1)

Every product detail page must show a bulk-pricing table:

| Quantity | Price/unit |
| -------- | ---------- |
| 5–19 kg  | ₹2,800/kg  |
| 20–49 kg | ₹2,600/kg  |
| 50+ kg   | ₹2,400/kg  |

This is non-negotiable for B2B. Price drops at quantity is how decisions get made.

---

## 11. Jobs-specific rules

### 11.1 Employment type is first-class

Four types, equal billing:

1. **Full-time monthly** — ₹/month
2. **Part-time** — ₹/month or ₹/day
3. **Contract · piece-rate** — ₹/saree, ₹/design, ₹/piece
4. **Daily-wage karigar** — ₹/day (the dominant model in Surat)
5. **Apprenticeship** — ₹/month (often token amount)

Job posting form, job filters, job cards, job detail — all must surface employment type prominently.

### 11.2 Application includes voice option

Job application form has three input modes:

1. **Profile + cover note** (default)
2. **Apply via WhatsApp** (secondary CTA)
3. **Record voice note** (link below form)

The voice option is critical for karigars who can't type Gujarati fluently.

### 11.3 Caller ID with intent (Naukri pattern, embroidery-adapted)

When an employer/recruiter calls a candidate from within Connect, the candidate's phone shows:

> **Zari360 Recruiter · Hiring for Multi-head Operator**
> [Workshop Name]

This is built via a cloud telephony layer (like Naukri / IndiaMART). Recruiter dials inside Connect → call routes through Zari360 number with intent header → candidate sees who's calling and why.

Spam-prone numbers can't ride this channel.

### 11.4 Pipeline (lite ATS)

Five stages, fixed: **Applied · Screened · Interviewed · Offered · Hired**.

Click-to-move in v1; drag-and-drop in v2.

Notes per candidate. Bulk actions (status update, message). Caller-ID intent integrated.

---

## 12. Notification rules (locked)

### 12.1 Channels

- In-app (web push + browser notification)
- Mobile push (PWA + native app later)
- WhatsApp (for high-importance items)
- Email (digest format)
- SMS (only for OTP + critical account events)

### 12.2 Per-module preferences

Settings page has a granular grid: rows are event types, columns are channels. User checks what they want where.

Default for new users:

- ERP alerts: all channels
- Job alerts: WhatsApp + push
- Inquiries: WhatsApp + push + email digest
- Profile views: weekly email digest only
- Marketing / tips: off by default (regulatory + UX hygiene)

### 12.3 Batching

- Likes / reactions: batch into "X and N others liked your post" — never one-per-event.
- Profile views: weekly digest by default, daily for Premium.
- Job alerts: at most 1/day to a candidate.
- Inquiries: never batch (each is a lead).

---

## 13. Search rules

### 13.1 One search bar, all entities

Top of every page. Searches: people, companies, jobs, products, posts.

Results page: tabs (All · People · Products · Jobs · Companies · Posts) with counts.

### 13.2 Synonym handling

Built-in synonyms for embroidery vocabulary:

- saree / sari / sadi → saree
- kurta / kurti → both
- zardozi / zardosi → zardozi
- bridal / wedding / shaadi → wedding
- machine / computerized / multi-head → multi-head computerized
- karigar / artisan / worker → karigar

### 13.3 Voice search

Every search input has a voice-search icon. Tapping it transcribes Gujarati/Hindi/English and shows the text before submitting.

### 13.4 Saved searches with alerts

Users can save a search. Save creates a named alert (e.g. "Multi-head Surat ₹500+/day") that triggers a WhatsApp/push notification on new matches.

---

## 14. Anti-patterns we have decided not to ship

A list of things competitors do that we explicitly will not do.

| Anti-pattern                               | Why we won't ship it                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Pay-to-be-seen**                         | Naukri / Apna get complaints that Premium throttles non-paying users' visibility. We don't gate basic discovery. |
| **Fake-friendly seller "verified" badges** | IndiaMART hands these out too easily. Ours is earned (GST / ERP / Udyam) and re-verified quarterly.              |
| **Aadhaar verification**                   | DPDP/UIDAI risk. We use GST/Udyam instead.                                                                       |
| **Hashtag follow pages**                   | LinkedIn killed these because they got gamed. Hashtags remain as search signals only.                            |
| **Anonymous reviews**                      | Both parties must confirm a deal before a review unlocks. No anonymous ratings.                                  |
| **Spam DM from recruiters**                | Cap cold outreach to N/day. Caller-ID with intent. Penalties for repeated complaints.                            |
| **Auto-translate hiding the original**     | Always show original + Translate option. Never auto-replace user's language.                                     |
| **Forced ratings prompts**                 | We ask for reviews once per closed deal, never repeatedly.                                                       |
| **Endless feed**                           | Window-paginate; show "You're caught up" after a healthy stop point.                                             |
| **Algorithmic feed only**                  | Always provide a chronological "Following" tab — LinkedIn just added this; we ship it from day one.              |
| **Aspirational gamification badges**       | "Top karigar," "Power seller" — we don't ship these in v1. Trust is earned via verification, not stickers.       |

---

## 15. Componentization roadmap (engineering)

Design system inherits AntD. We extend with these custom components:

| Component               | Wraps / extends              | Notes                                                               |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `<TrustBadgeRow>`       | AntD `<Tag>` group           | Renders ERP-linked + GST + Udyam in tiered order; handles overflow  |
| `<EmptyState>`          | AntD `<Empty>`               | Slots: illustration, headline, subhead, primaryCTA, secondaryCTA    |
| `<VoiceNoteRecorder>`   | new                          | Waveform, duration, transcribe button                               |
| `<WhatsAppCTA>`         | AntD `<Button>`              | Always green, always has the pre-fill context handler               |
| `<LeadCard>`            | AntD `<Card>`                | Lead Manager rows: buyer, product, status pill, actions             |
| `<PipelineColumn>`      | new                          | Posted Jobs ATS column                                              |
| `<RateRow>`             | new                          | Daily-wage / piece-rate / monthly slots in profile and job postings |
| `<ContextBar>`          | new                          | Pinned context bar in Inbox                                         |
| `<CallerIDBanner>`      | new                          | Recruiter dashboard explanation                                     |
| `<ProfileStrengthCard>` | AntD `<Progress>` + `<List>` | Profile strength + checklist + actions                              |
| `<ModuleTabs>`          | AntD `<Tabs>`                | Standardized for Jobs / Network / Marketplace sub-tabs              |
| `<ERPLinkedPanel>`      | new                          | The trust panel that explains the moat                              |

---

## 16. Tracking and analytics events (locked)

So we can measure whether the design works. Capture from day 1.

| Event                             | Captured where                          | Why                            |
| --------------------------------- | --------------------------------------- | ------------------------------ |
| `connect.signup.completed`        | After OTP                               | Funnel start                   |
| `connect.intent.selected`         | After intent question                   | Routing decision               |
| `connect.workspace.created`       | On workspace creation                   | ERP onboarding pickup          |
| `connect.profile.completion`      | On every profile-strength milestone     | Engagement curve               |
| `connect.post.created`            | On every Feed post                      | Content engagement             |
| `connect.inquiry.sent`            | Marketplace inquiry                     | Lead-gen funnel                |
| `connect.inquiry.responded`       | Seller responds                         | Lead-gen conversion            |
| `connect.whatsapp.handoff`        | "Continue on WhatsApp" tap              | Off-platform tracking          |
| `connect.job.applied`             | Apply button                            | Jobs funnel                    |
| `connect.job.viewed_by_recruiter` | Application opened                      | Naukri-style status update     |
| `connect.deal.confirmed`          | Both parties confirm deal               | Review unlock + future credits |
| `connect.review.submitted`        | After deal confirmed                    | Trust loop                     |
| `connect.erp_link.gained`         | First time workspace becomes ERP-linked | Moat activation                |
| `connect.erp_link.lost`           | Silent decay after 60 days              | Retention alert                |

---

## 17. Open items still pending design-side

These don't block the merged system but must be resolved as we go:

| Item                                                                                             | Resolve before                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------ |
| Final illustration system (custom or stock) for empty states                                     | Wireframe completion           |
| Brand color palette extensions for badge tiers                                                   | Component library kickoff      |
| Voice-note transcription provider (Whisper API / Google Speech / Sarvam AI for Indian languages) | Phase 2                        |
| Cloud telephony provider for Caller-ID-with-intent                                               | Phase 3                        |
| Reviews moderation workflow (manual queue vs automated toxicity classifier)                      | Phase 2                        |
| Featured / pinned content time-limits on Company Pages                                           | Phase 4                        |
| Sticker / reaction set beyond AntD defaults (industry-specific?)                                 | Phase 4                        |
| Light / dark mode strategy                                                                       | Phase 5                        |
| Right-to-left readiness (not needed for Gu/Hi/En, but reserved for future)                       | When Urdu support is requested |

---

## 18. Sign-off

Once you've read and reacted, we lock this doc. Lock means:

- Future wireframes use these rules without re-litigating
- Engineering builds the components in section 15 against this spec
- Any deviation goes through a change-request comment in this doc

After sign-off, I'll start the 5 missing pieces:

1. Onboarding flow (intent question + post-signup home + zero-workspace path)
2. Mobile feed
3. Mobile marketplace + product detail
4. Post composition flows (text, photo, video, voice, product, job, requirement)
5. Empty states gallery (the day-1 karigar experience)

Each delivered as its own wireframe artifact in this chat.

---

_End of design decisions doc v1. Comments and overrides go inline._
