// Vercel Serverless Function — creates a booking from the public page.
//
// The PWA's own conflict check (attemptSaveBooking, in the staff app) checks
// a staff device's local state, then merges into whatever the cloud row
// currently holds — but never re-checks the conflict against that freshly
// -fetched cloud data before writing, so two people can each pass their own
// stale check and both land a real double-booking. That gap is being left
// alone in the PWA for now (flagged separately), but there's no reason to
// carry it into new code: this endpoint re-fetches immediately before
// writing and uses updated_at as a compare-and-swap guard, so a genuine
// last-second collision is retried against fresh data rather than silently
// let through.

import crypto from "node:crypto";

const ALLOWED_ORIGINS = [
  "https://pospro-portal.vercel.app",
  "https://www.pospro-portal.com",
  "https://pospro-portal.com",
  "https://client.pospro-portal.com",
  "https://pwa.pospro-portal.com",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/pospro(-portal|-pwa)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function supa(path, init) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  return fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
}

// Same helpers as the PWA's Bookings module (BookingsView, App.jsx) —
// duplicated here on purpose since this runs as an isolated serverless
// function, not a shared package. Keep in sync if the PWA's logic changes.
const addMinutes = (time, mins) => {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const hh = Math.floor((total % 1440) / 60), mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
const minutesBetween = (start, end) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) diff += 1440;
  return diff;
};
const hasConflict = (bookings, resourceId, date, time, durationMinutes, excludeId) => {
  if (!resourceId || !time) return false;
  const newEnd = addMinutes(time, durationMinutes || 30);
  return bookings.some(b => {
    if (b.id === excludeId) return false;
    if (b.status === "cancelled") return false;
    if (b.resourceId !== resourceId || b.date !== date || !b.time) return false;
    const bEnd = addMinutes(b.time, b.durationMinutes || 30);
    return time < bEnd && b.time < newEnd;
  });
};

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slug, serviceId, resourceId, date, time, endTime, customerName, customerPhone, notes } = req.body || {};

  if (!slug) return res.status(400).json({ error: "Missing store" });
  if (!serviceId) return res.status(400).json({ error: "Missing service" });
  if (!date) return res.status(400).json({ error: "Date required" });
  if (!customerName || !String(customerName).trim()) return res.status(400).json({ error: "Name required" });
  if (!customerPhone || !String(customerPhone).trim()) return res.status(400).json({ error: "Phone number required" });

  const storeRows = await (await supa(`stores?booking_slug=eq.${encodeURIComponent(String(slug).toLowerCase())}&select=id`)).json();
  const store = storeRows[0];
  if (!store) return res.status(404).json({ error: "Store not found" });

  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dataRows = await (await supa(
      `store_data?store_id=eq.${encodeURIComponent(store.id)}&select=enable_bookings,booking_services,booking_resources,bookings,updated_at`
    )).json();
    const row = dataRows[0];
    if (!row || !row.enable_bookings) return res.status(404).json({ error: "Bookings are not enabled for this store" });

    const svc = (row.booking_services || []).find(s => s.id === serviceId && s.active !== false);
    if (!svc) return res.status(400).json({ error: "This service is no longer available" });

    if (svc.resourceRequired && !resourceId) return res.status(400).json({ error: "Please select a resource" });
    if (resourceId) {
      const res_ = (row.booking_resources || []).find(r => r.id === resourceId && r.active !== false);
      if (!res_) return res.status(400).json({ error: "This resource is no longer available" });
    }
    if (svc.exclusivity && !time) return res.status(400).json({ error: "A time is required for this service" });
    if (svc.durationMode === "flexible" && time && !endTime) return res.status(400).json({ error: "End time required" });

    const durationMinutes = svc.durationMode === "flexible" && time && endTime
      ? minutesBetween(time, endTime)
      : svc.durationMinutes;
    if (svc.durationMode === "flexible" && time && durationMinutes <= 0) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    if (svc.exclusivity && resourceId && time) {
      if (hasConflict(row.bookings || [], resourceId, date, time, durationMinutes, null)) {
        // A real conflict — not a race, an actual taken slot. Don't retry,
        // tell the customer so they can pick another time.
        return res.status(409).json({ error: "That slot was just taken. Please pick another time." });
      }
    }

    const toSave = {
      id: "bk" + crypto.randomBytes(6).toString("hex"),
      serviceId, serviceName: svc.name,
      resourceId: resourceId || null,
      resourceName: resourceId ? ((row.booking_resources || []).find(r => r.id === resourceId)?.name || "") : null,
      customerId: null,
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      date, time: time || "", endTime: endTime || undefined,
      durationMinutes,
      status: "confirmed", // Stage 3 payment flow will likely gate this behind a "pending" state before confirming
      notes: notes ? String(notes).trim() : "",
      createdAt: new Date().toISOString(),
      createdBy: "online booking",
      source: "public_booking_page",
    };

    const merged = [toSave, ...(row.bookings || [])];
    const patchRes = await supa(
      `store_data?store_id=eq.${encodeURIComponent(store.id)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
      { method: "PATCH", body: JSON.stringify({ bookings: merged, updated_at: new Date().toISOString() }) }
    );
    const patched = patchRes.ok ? await patchRes.json() : [];
    if (patched.length > 0) {
      return res.status(200).json({ ok: true, bookingId: toSave.id });
    }
    // updated_at moved under us (someone else wrote in between) — loop and
    // re-check against whatever is there now.
    await new Promise(r => setTimeout(r, 120 + Math.random() * 200));
  }

  return res.status(409).json({ error: "Couldn't confirm this booking due to a conflict. Please try again." });
}
