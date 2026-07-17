# Reseats — SMS Onboarding Scripts (New Number via QR)

Triggered when a customer scans the checkout QR code and their phone number has no existing Reseats account.

---

## 1. QR Scan → First Text

**Trigger:** Customer scans QR, taps "text to save," phone's SMS app opens pre-filled, they hit send
```
Got it — saving your receipt from {{merchant_name}} now. First time here? Reply with your name and we'll set up your Reseats vault (takes 10 seconds).
```

---

## 2. Name Reply → Verification Code

**Trigger:** Customer replies with their name
```
Thanks, {{customer_name}}! One quick step — reply with this code to confirm it's your number: {{otp_code}}
```

**On incorrect code (retry, max 3 attempts):**
```
That code didn't match. Please try again, or reply STOP to cancel.
```

---

## 3. Verified → Confirmation

**Trigger:** Correct code received
```
You're all set! Your receipt from {{merchant_name}} ({{purchase_amount}}) is saved to your Reseats vault. We'll keep every receipt from here on out — no more doing anything.
```

---

## 4. Ongoing Receipts (returning number, no action needed)

**Trigger:** Any future checkout QR scan or forwarded receipt from a verified number
```
Saved: {{merchant_name}}, {{purchase_amount}}, {{date}}. View anytime: reseats.app/vault
```

---

## 5. Cross-Product Nudge (only shown once, first time relevant)

**Trigger:** First receipt saved for a number that has never used VentText
```
Quick tip — if a purchase ever goes wrong, text VentText and your Reseats receipt attaches automatically. No photos needed.
```

---

## 6. Opt-Out / Compliance

```
You've been unsubscribed from Reseats. Reply START to opt back in. Your saved receipts remain in your vault.
```

**Footer for first message in any new thread (carrier compliance):**
```
Msg&data rates may apply. Reply STOP to opt out, HELP for help.
```

---

## Why this is simpler than the webpage flow
- No page load, no typing on a small screen beyond a name and a code
- Same channel the customer is already in (texting), same mental model as VentText
- One shared verification system: a number verified for Reseats is already verified if they later text VentText — no separate login screens to design, maintain, or get people to visit
