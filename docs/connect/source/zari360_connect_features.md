# Zari360 Connect — Feature Research & Inventory

**Purpose:** Synthesize learnings from LinkedIn, IndiaMART, Naukri, and vertical-SaaS patterns into a feature inventory specific to Zari360 Connect. Use this as the base for the PRD and wireframes.

**Status:** Research draft v1. Review, mark features in/out/later, then we lock the scope and wireframe.

---

## Executive Summary

Researched four reference platforms plus vertical-SaaS patterns (Toast, Procore, Clio):

- **LinkedIn (2026)** — identity layer, social graph, content feed, jobs, company pages, premium analytics, identity verification, vertical video, hashtag deprioritization
- **IndiaMART** — lead-gen marketplace (not transactional), supplier subscriptions, BuyLeads/RFQs, cloud telephony, GST verification, AI matching, mobile-first for Indian SMEs
- **Naukri** — AI job matching, video profiles, Nvites (recruiter direct invites), profile completeness, resume database, ATS, caller ID, recruiter dashboards
- **Vertical SaaS pattern** — own the workflow deeply → become the OS for that industry → multiple revenue streams compound

The big insight: **none of the references have operational data from inside factories.** Zari360 does (ERP). That is the moat — every feature decision in Connect should reinforce it or be reinforced by it.

This doc lists features organized by Connect module, marks the embroidery-industry-specific adaptations, lists anti-patterns to avoid, and recommends the tool stack.

---

## 1. Feature Inventory by Module

### A. Person Profile (LinkedIn-driven, embroidery-adapted)

**Core (must-have, Phase 1–4)**

- Headline + summary (multilingual; one profile, one language toggle per viewer)
- Profile photo + cover photo
- Location, languages spoken (Gujarati, Hindi, English, Marwari, etc.)
- Experience timeline — companies/workshops, role, dates, description
- Skills — with endorsements from connections (embroidery-specific skill taxonomy, not generic IT/business)
- Portfolio — photos and short videos of work samples (the most important section for karigars/designers — visual proof matters more than text in this industry)
- Education / training / apprenticeship (formal + informal — many karigars learned on the job)
- Recommendations — written endorsements from people who worked with you
- Certifications (if any — embroidery courses, machine training certs)
- "Open to work" / "Open to hiring" / "Open to deals" toggles

**Trust & verification (Phase 2+)**

- Mobile + email verified (default)
- GSTIN verified badge (if user owns a workspace with GST)
- Udyam verified badge
- ERP-linked badge — _unique to Zari360_: "Verified by Zari360 ERP" means there's real operational data behind this person (active workspace, attendance records, etc.). This is the moat made visible.

**Engagement signals (Phase 4)**

- Profile views (last 7/30 days)
- Search appearances ("you appeared in N searches")
- Post impressions
- Profile completeness meter with prompts

**Industry-specific adaptations**

- Skill taxonomy: aari, zardozi, machine embroidery, hand embroidery, computerized, kasab, gota patti, sequins, beadwork, designing, pattern-making, etc. — pre-defined; users select from a list rather than free-text
- Machine type tagged on portfolio items (single-needle, multi-head, computerized, etc.)
- Work type tags on each portfolio item (saree, lehenga, suit, fabric, accessory)
- Daily-wage rate field (optional) — many karigars work daily-wage, not monthly
- "Years in industry" prominent — experience matters more than degrees here

---

### B. Network & Connections (LinkedIn-driven)

**Core**

- Connections (symmetric, person ↔ person)
- Follows (asymmetric, person → Company Page)
- 1st / 2nd / 3rd degree visibility
- Connection requests with optional notes
- "People you may know" — recommendations based on:
  - Same workspace (current or past)
  - Same city / area within Surat
  - Same skill set
  - Mutual connections
  - Same community/network (handle carefully — see anti-patterns)
- Block, mute, report
- Connection limit (LinkedIn caps at 30,000 — Zari360 probably doesn't need a cap initially)

**Discovery**

- Search people by name, skill, location, workspace, role
- Filter by verification status
- Search shows 1st/2nd/3rd degree relationship inline

**Phase 4+**

- "Who viewed your profile" (premium feature, like LinkedIn)
- Connection insights ("you have N mutual connections with this person")

---

### C. Feed (LinkedIn-driven, vertical-adapted)

**Post types**

- Text post
- Photo post (single or carousel — critical for embroidery, where visuals dominate)
- Video post — short-form, vertical-first (LinkedIn's 2026 pivot validates this for B2B too)
- Document post (PDF, e.g. design samples, catalogs)
- Poll
- Product post — composed from a Store listing
- Job opening post — composed from a Job posting
- Job requirement post — "looking for karigar with X skill in Surat"
- Article / longer-form post (Phase 5+)

**Engagement**

- Reactions: like, celebrate, support, insightful, curious (LinkedIn-style — more nuanced than just "like")
- Comments + nested replies
- Shares / reposts (with or without commentary)
- Save post (for later)
- Hashtags (used as search signals, not as a follow-the-tag feature — LinkedIn killed that)
- @mentions
- Hide / report
- Share to WhatsApp button (critical for Indian B2B — this is how things actually move)

**Ranking signals**

- Recency
- Engagement velocity (reactions/comments in first hour)
- Affinity (you interact with this person/page often)
- Content-type fit (you tend to engage with videos, show more videos)
- Relevance to your skills / workspace type
- Location proximity (Surat-area content boosted for Surat users)

**Feed views (Phase 4+)**

- "For You" (algorithmic)
- "Following" (only people/pages you follow, chronological — LinkedIn just added this)
- Hashtag / topic feeds

**Industry-specific adaptations**

- "Trending designs" surface — visual-first browsing of what's getting attention
- "Available karigars near you" surface — pulls from "Open to work" toggle
- "Live orders / requirements" surface — pulls from job-requirement and inquiry posts
- Language-filtered feed (default to user's preferred language; show others on demand)

---

### D. Marketplace (IndiaMART-driven, lead-gen model)

**Decision already locked:** No cart, no checkout, no payment, no shipping. Deals close on phone/WhatsApp. This is correct for Surat embroidery B2B.

**Product listing**

- Multiple images per product (4-8 recommended; angles matter for fabric/material)
- Short video (Phase 3)
- Title, category, subcategory
- Specs (material composition, GSM for fabrics, thread count, dimensions, weight)
- MOQ (minimum order quantity)
- Price range (per piece / per meter / per kg) — show range, not fixed price; that's how Indian B2B works
- Stock status (in stock / made-to-order / limited)
- HSN code (for GST)
- Tags / search keywords

**Buyer-side discovery**

- Browse by category, subcategory, sub-subcategory (deep taxonomy — embroidery has many subdivisions)
- Filter by: location, MOQ range, price range, verified seller, rating, response time
- Search with autocomplete and synonym handling (saree/sari, kurti/kurta, etc.)
- Save products, save searches, set alerts
- "Recently viewed" memory
- Recommended products based on browsing history

**Inquiry / lead flow** (the IndiaMART pattern)

- "Get Quotation" button (NOT "Buy")
- Inquiry form: quantity needed, target price, delivery timeline, message, contact preference (call / WhatsApp / on-platform chat)
- Seller receives inquiry in Connect Inbox + push notification + SMS
- Phone reveal: only after seller accepts inquiry, OR after both parties have engaged once
- One-click WhatsApp handoff (with pre-filled context)

**RFQ / BuyLeads (reverse listings — wholesaler-side)**

- Buyer posts "I want to buy X bulk" — sellers respond with quotations
- Sellers see RFQs matched to their product categories
- Free for buyers; sellers may pay for unlimited RFQ access (Phase 5)

**Seller-side workflow**

- Seller storefront (separate URL `/store/<slug>`)
- Catalog manager
- Lead Manager — inquiries inbox, notes per lead, follow-up reminders, status tags (new / contacted / quoted / negotiating / won / lost)
- Quotation builder — generate a PDF quote from inquiry details
- Cloud telephony / masked numbers (Phase 3+) — like IndiaMART's premium number service, protects both sides from spam after deal ends

**Trust signals**

- GST verified badge
- Udyam verified badge
- ERP-linked badge (this is unique to Zari360 — sellers with active ERP usage = more trustworthy)
- Years in business
- Response time average
- Response rate
- Reviews & ratings — _post-deal-confirmation only_ (both parties confirm deal happened → unlock reviews; prevents fake reviews)
- Repeat-buyer count (Phase 5)

**Industry-specific adaptations**

- Categories: fabrics, threads, beads, sequins, zari, zardozi material, kasab, machine accessories, needles, frames, finished garments, sarees, etc. — taxonomy pre-built, not generic
- Color picker filter (visual color match)
- Fabric weight / GSM filter
- Bulk order calculator (price per piece at different quantities)

---

### E. Jobs (Naukri + LinkedIn hybrid, karigar-adapted)

**Job posting (employer side)**

- Structured fields: role, location, experience required, salary range, skills required, employment type
- **Employment type is critical and embroidery-specific:**
  - Full-time monthly
  - Part-time
  - Contract / piece-rate (paid per saree, per design)
  - Daily-wage karigar (most common in Surat)
  - Apprenticeship
- Job description (rich text)
- Number of openings
- Posting expiry (default 30 days, extendable)
- Boost / featured (paid, Phase 5)

**Candidate-side**

- Browse jobs with filters (location, role, salary, type, posted date, skills, company size)
- "Open positions only" default filter
- Apply with profile + optional cover note + optional resume
- Application status tracking: Applied → Viewed → Shortlisted → Rejected/Hired
- Save jobs, set job alerts (push + WhatsApp + email)
- Recommended jobs based on profile + location proximity

**Recruiter-side (employer dashboard)**

- Candidate search across all profiles on platform
- Filter by: skills, experience, location, salary expectation, available status, last active
- Shortlist / save candidates
- Message candidates directly (DM)
- Lite ATS pipeline: applied → screened → interviewed → offered → hired (or rejected)
- Notes per candidate
- Bulk actions (send mass message, status update)
- Nvites — direct invite to candidate to apply (Naukri pattern; very effective in India)
- Caller ID with intent (when calling candidate, show "Zari360 Recruiter: Hiring for X" on their screen — Naukri innovation)

**Premium / monetization (Phase 5)**

- Featured job posts (top of search)
- Unlimited candidate search
- Resume database access (paid tiers)
- Verified employer badge

**Industry-specific adaptations**

- Skill taxonomy = same embroidery taxonomy as Profile
- Salary fields: monthly salary range AND daily-wage range AND piece-rate range (different markets)
- "Hire for which machine type" tagged on job postings
- WhatsApp-first communication option (many karigars don't check email)
- Voice-note application option (Phase 3+) — for low-literacy candidates

---

### F. Company Page (LinkedIn Pages-driven, B2B-tilted)

**Core**

- Page profile (name, logo, cover, about, location, founded year, size, type)
- Verified badge (GST + Udyam linked)
- Followers
- Tabs: About, Posts, Products (links to Store), Jobs (links to Job postings), People (employees who listed this company)
- Page admins (multiple)
- Post as Page (separate from posting as personal identity)
- Page analytics (visitors, follower growth, post performance) — Phase 4

**Phase 4+**

- Featured section (pin top content — case studies, big posts)
- Newsletters (LinkedIn launched this in 2025/2026; vertical platforms may follow)
- Live events / video (Phase 5)
- Recommendations / testimonials from other businesses

**Industry-specific adaptations**

- "Specialization" field (what kind of embroidery this workshop does)
- "Machine capacity" (number of machines, types) — optional, owner-controlled
- "Production capacity / month" — optional
- "Languages we work in" — for buyer-seller match
- Auto-populated employees from team members who list this workspace in their Profile experience (with their consent)

---

### G. Cross-cutting infrastructure

**Unified Inbox**

- One inbox, filter chips: All / DMs / Inquiries (marketplace) / Applications (jobs) / Quotation requests / System
- Per-thread context (which product / job / page the conversation is about)
- WhatsApp handoff (export thread to WhatsApp with one tap)
- Voice notes
- File attachments
- Read receipts (toggle in privacy settings)
- Typing indicators
- Message templates (for sellers — auto-reply to common inquiries)

**Unified Notifications**

- Granular per-module preferences (don't let marketplace promos drown ERP attendance alerts)
- Channels: in-app push, browser push, WhatsApp, email, SMS
- Smart batching (collapse "X liked your post" × N into "X and 5 others")

**Unified Search**

- One bar searches: people, companies, jobs, products, posts
- Auto-detects intent ("zari wholesaler in Surat" → people + companies in marketplace)
- Filters by entity type after initial search
- Recent searches
- Saved searches with alerts

**Identity Verification (Phase 2+)**

- Mobile OTP (existing)
- Email verification (existing)
- GST API verification (free, instant, official)
- Udyam API verification
- _No Aadhaar_ (DPDP risk; locked decision in project context)
- ERP-active badge — _unique moat signal_

---

## 2. Embroidery Industry Layer (What's Different)

These are adaptations specific to Surat embroidery B2B that the reference platforms don't handle:

1. **Visual-first everything.** Portfolio quality matters more than written summary. Product images matter more than spec sheets. Default to image-grid layouts where possible.

2. **WhatsApp is the close.** Every meaningful action should have a "Continue on WhatsApp" button. We capture the lead, they close on WhatsApp. Don't fight this; embrace it.

3. **Language layering.** Gujarati + Hindi + English minimum, with Marwari and Bengali as Phase 3+ adds. Single profile, but UI language is per-viewer. Don't force users to maintain multiple language versions of their content (translate on the fly or accept multilingual posts).

4. **Voice and low-literacy paths.** Voice-note posting, voice-note applications, voice search. Many users can't type Gujarati or English fluently.

5. **Daily-wage & piece-rate as first-class concepts.** Most karigars don't have salaries; they have rates per saree or per day. Jobs and Profiles must accommodate this.

6. **Workshop-as-extension-of-person.** A small shop owner IS the workshop. Don't force a hard separation between person profile and business page. Linking should be smooth, one-tap.

7. **Community trust > review counts.** "Verified by Zari360 ERP" + "12 mutual connections" + "Friend of [respected person]" beats five-star reviews from strangers. Surface social proof from the user's actual network.

8. **Seasonal cycles.** Wedding season, festival seasons drive massive demand spikes. Feed and recommendations should respect this.

9. **Hindi/Gujarati search synonyms.** Saree/sari/sadi, kurti/kurta, zardozi/zardosi — handle these gracefully in search.

10. **Phone reveal economics.** IndiaMART makes money by hiding phones. We can do the same as a Phase 5 monetization — free contact for a few inquiries per month, paid for more.

---

## 3. Anti-Patterns to Avoid

Reference platforms have well-known problems. We should not repeat them:

- **Naukri's "pay-to-be-seen" trap.** Multiple user complaints that after buying Premium, visibility drops to force upgrades. We must not let monetization gate basic visibility.
- **IndiaMART's spam-seller problem.** Verification must be more than a one-time GST check. Re-verify quarterly. Penalize sellers with repeated complaint patterns.
- **LinkedIn's content over-formality.** Many karigars and shop owners won't write LinkedIn-style polished posts. Lower the bar — short captions on photos should feel normal, like Instagram or WhatsApp Status.
- **Fake reviews.** Reviews only after both parties confirm a deal happened. No review-bombing.
- **Hashtag dependency.** LinkedIn killed hashtag follow pages because they got gamed. Use hashtags as search signals only.
- **Recruiter spam to candidates.** Cap how many cold contacts a recruiter can make per day per candidate. Caller-ID with intent (Naukri pattern) before calling.
- **Notification fatigue.** Aggressive notification batching from day one. The platform that wins this market is the one that respects users' attention.

---

## 4. Recommended Tool Stack

| Need                        | Tool                                                                                  | Why                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PRD / spec docs             | **Notion** (you have it connected via MCP — I can write directly into your workspace) | Industry standard for product docs; collaborative; AI-friendly                                                                                  |
| Wireframes (final)          | **Figma**                                                                             | Industry standard; engineering can inspect specs; supports component libraries to match your AntD system                                        |
| Wireframes (fast iteration) | **Inline sketches here** in this chat                                                 | Faster than Figma for first-draft layouts; I can render SVG/HTML wireframes inline so we iterate visually in minutes before committing to Figma |
| User flows / diagrams       | **Excalidraw** or **inline visualizer here**                                          | Faster than Figma for flow diagrams; lower commitment                                                                                           |
| Component design system     | **Figma + AntD Figma kit**                                                            | Stay aligned with your existing AntD frontend                                                                                                   |
| Whiteboarding / brainstorm  | **FigJam** or **Miro**                                                                | When sketching ideas with the team                                                                                                              |
| Prototyping (clickable)     | **Figma prototypes**                                                                  | If you want clickable mockups for user testing                                                                                                  |
| User testing / feedback     | **Maze** or **UserTesting**                                                           | Validate wireframes with real karigars/shop owners before building                                                                              |

**My recommended path:**

1. We finalize this feature inventory together (this doc)
2. I write the **PRD into your Notion workspace** (one master doc + per-module sub-docs)
3. I sketch wireframes inline here for each Connect home + each module so you can react fast
4. Once we lock the wireframes inline, you commission Figma versions (or I produce HTML/SVG mockups that can serve as production reference)

---

## 5. Decisions Needed From You

Before I write the PRD or wireframes, mark each feature in this inventory as:

- ✅ **In v1** — ships in Phase 1–3
- 🕓 **Later** — Phase 4+
- ❌ **Out** — skip entirely
- ❓ **Discuss** — needs a conversation

We'll go module by module if you want, or you can mark them all and come back.

---

## 6. Next Step

Two paths — you pick:

**Path A (recommended for depth):** Review this doc, mark features, then we wireframe Connect Home first, then each module's main page. Each wireframe gets reviewed inline before we move on.

**Path B (fast):** Skip review of this doc, trust the inventory, jump straight to the Connect Home north-star wireframe.

Path A is slower but you'll catch missing features early. Path B is faster but more rework risk.

---

_Generated from research on LinkedIn (2026), IndiaMART, Naukri, plus vertical-SaaS patterns (Toast, Procore, Clio). Cross-referenced with Zari360 project context._
