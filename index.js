require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const crypto = require("crypto");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Environment validation ────────────────────────────────────────────────
const required = ["JWT_SECRET", "ADMIN_PASSWORD_HASH", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RESEND_API_KEY", "PAYSTACK_SECRET_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const EMAIL_FROM = process.env.EMAIL_FROM || "The Open Scroll <onboarding@resend.dev>";

const normalizeOrigin = (origin) =>
  String(origin || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
};

const sanitizeBookPayload = (payload = {}) => ({
  title: String(payload.title || "").trim(),
  author: String(payload.author || "").trim(),
  genre: String(payload.genre || "").trim(),
  price: toNumber(payload.price, 0),
  description: String(payload.description || ""),
  content: String(payload.content || ""),
  pages: Math.max(0, Math.floor(toNumber(payload.pages, 0))),
  published: toBoolean(payload.published, false),
  coverPalette: Math.max(0, Math.floor(toNumber(payload.coverPalette, 0))),
  coverPattern: Math.max(0, Math.floor(toNumber(payload.coverPattern, 0))),
  coverImage: payload.coverImage ? String(payload.coverImage) : null,
});

// ─── Supabase client (service role — full access, backend only) ────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Resend email client ───────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Email helpers ─────────────────────────────────────────────────────────
const baseEmailHtml = (content) => `
  <div style="background:#0b0810;color:#ede0cc;padding:40px;font-family:Georgia,serif;max-width:600px;margin:0 auto;">
    <div style="color:#c9a84c;font-size:22px;margin-bottom:8px;">The Open Scroll</div>
    <div style="color:#6a5a4a;font-size:12px;margin-bottom:32px;letter-spacing:0.15em;text-transform:uppercase;">by Abednego Appiah Mensah</div>
    ${content}
    <div style="border-top:1px solid #2a1e3a;padding-top:24px;color:#4a3a5a;font-size:12px;font-style:italic;margin-top:32px;">
      "What I tell you in darkness, speak in the light." — Matthew 10:27
    </div>
  </div>
`;

// ─── PDF generation ────────────────────────────────────────────────────────
async function generateBookPDF(book) {
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const timesItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const cover = pdfDoc.addPage([595, 842]);
  cover.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.07, 0.03, 0.06) });

  if (book.coverImage) {
    try {
      const imgRes = await axios.get(book.coverImage, { responseType: "arraybuffer" });
      const contentType = imgRes.headers["content-type"] || "";
      let embeddedImage;
      if (contentType.includes("png")) {
        embeddedImage = await pdfDoc.embedPng(imgRes.data);
      } else {
        embeddedImage = await pdfDoc.embedJpg(imgRes.data);
      }
      cover.drawImage(embeddedImage, { x: 0, y: 0, width: 595, height: 842 });
      cover.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0, 0, 0), opacity: 0.45 });
    } catch (imgErr) {
      console.error("Cover image embed failed:", imgErr.message);
    }
  }

  cover.drawText("THE OPEN SCROLL", { x: 50, y: 780, size: 11, font: timesRoman, color: rgb(0.79, 0.66, 0.30) });
  cover.drawText(book.title, { x: 50, y: 680, size: 28, font: timesBold, color: rgb(0.93, 0.88, 0.80), maxWidth: 495, lineHeight: 36 });
  cover.drawText(`by ${book.author}`, { x: 50, y: 620, size: 14, font: timesItalic, color: rgb(0.79, 0.66, 0.30) });
  cover.drawLine({ start: { x: 50, y: 600 }, end: { x: 545, y: 600 }, thickness: 0.5, color: rgb(0.79, 0.66, 0.30) });
  cover.drawText(book.genre || "", { x: 50, y: 580, size: 11, font: timesRoman, color: rgb(0.54, 0.44, 0.42) });
  if (book.description) {
    cover.drawText(book.description.slice(0, 300), { x: 50, y: 520, size: 12, font: timesItalic, color: rgb(0.54, 0.44, 0.42), maxWidth: 495, lineHeight: 18 });
  }

  const lines = (book.content || "").split("\n");
  let pageLines = [];
  const maxLines = 38;
  for (const line of lines) {
    if (line.trim() === "") { pageLines.push(""); continue; }
    const words = line.split(" ");
    let current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > 85) {
        pageLines.push(current.trim());
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) pageLines.push(current.trim());
  }

  for (let i = 0; i < pageLines.length; i += maxLines) {
    const page = pdfDoc.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.07, 0.03, 0.06) });
    const chunk = pageLines.slice(i, i + maxLines);
    chunk.forEach((line, idx) => {
      if (!line) return;
      const isChapter = /^(Chapter|Foreword|Prologue|Preface|Part|Opening|Introduction|\d+\.)/i.test(line);
      page.drawText(line, {
        x: 60,
        y: 790 - idx * 19,
        size: isChapter ? 13 : 12,
        font: isChapter ? timesBold : timesRoman,
        color: isChapter ? rgb(0.79, 0.66, 0.30) : rgb(0.80, 0.75, 0.68),
        maxWidth: 475,
      });
    });
    page.drawText(`${Math.floor(i / maxLines) + 1}`, {
      x: 290,
      y: 30,
      size: 10,
      font: timesRoman,
      color: rgb(0.4, 0.3, 0.3),
    });
  }

  return await pdfDoc.save();
}

async function sendBookEmail(to, name, book, pdfBytes) {
  await resend.emails.send({
    from: EMAIL_FROM,
    to,
    subject: `✦ Your Book: ${book.title} — The Open Scroll`,
    html: baseEmailHtml(`
      <div style="font-size:18px;margin-bottom:16px;">Dear ${name},</div>
      <p style="color:#8a7870;line-height:1.9;margin-bottom:24px;">
        Thank you for your purchase. Your book <strong style="color:#c9a84c;">${book.title}</strong> is attached as a PDF.
      </p>
      <p style="color:#8a7870;line-height:1.9;">
        May God bless your reading and may every word minister deeply to your spirit.
      </p>
    `),
    attachments: [{
      filename: `${book.title.replace(/\s+/g, "_")}_OpenScroll.pdf`,
      content: Buffer.from(pdfBytes).toString("base64"),
    }],
  });
}

// ─── Multer — memory storage for Supabase upload ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

// ─── PAYSTACK WEBHOOK (raw body required — must be BEFORE express.json()) ──
// Register this URL in Paystack Dashboard → Settings → Webhooks
app.post("/api/payment/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET)
    .update(req.body)
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Bad payload");
  }

  // Respond immediately — Paystack expects a fast 200
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const { reference, metadata, customer, amount, currency } = event.data;

  // Idempotency — skip if already processed
  const { data: usedRef } = await supabase
    .from("used_payment_refs")
    .select("reference")
    .eq("reference", reference)
    .single();
  if (usedRef) return;

  const bookId = metadata?.bookId;
  if (!bookId) return;

  const { data: book } = await supabase.from("books").select("*").eq("id", Number(bookId)).single();
  if (!book) return;

  const orderData = {
    bookId: book.id,
    bookTitle: book.title,
    email: customer.email,
    name: metadata.name || customer.email,
    amount: amount / 100,
    currency,
    reference,
    emailDelivered: false,
    paidAt: new Date().toISOString(),
  };

  const { data: order } = await supabase.from("orders").insert([orderData]).select().single();
  await supabase.from("used_payment_refs").insert([{ reference }]);
  await supabase.from("books").update({ downloads: (book.downloads || 0) + 1 }).eq("id", book.id);

  try {
    const pdfBytes = await generateBookPDF(book);
    await sendBookEmail(customer.email, metadata.name || "Beloved", book, pdfBytes);
    await supabase.from("orders").update({ emailDelivered: true }).eq("reference", reference);
  } catch (emailErr) {
    console.error(`[WEBHOOK DELIVERY FAILURE] ${customer.email}:`, emailErr.message);
  }
});

// ─── Middleware (ORDER MATTERS — helmet and trust proxy must be first) ─────
app.set("trust proxy", 1); // Required for Render — fixes rate limiting per real user IP

app.use(helmet()); // Security headers — must be before routes

const allowedOrigins = new Set(
  [
    FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(process.env.ALLOWED_ORIGINS || "").split(","),
  ]
    .map(normalizeOrigin)
    .filter(Boolean)
);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.has(normalizeOrigin(origin))) return cb(null, true);
    cb(new Error(`CORS: Origin '${origin}' not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));

// ─── Rate limiting (applied per-route) ────────────────────────────────────
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many attempts" } }));
app.use("/api/books/:id/download", rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: "Too many downloads. Wait a minute." } }));
// ✅ NEW: Protect spam-able public endpoints
app.use("/api/newsletter", rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: "Too many signups from this IP" } }));
app.use("/api/inquiries", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Too many messages from this IP" } }));
app.use("/api/payment/initialize", rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: "Too many payment attempts from this IP" } }));

// ─── Auth middleware ───────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
};

const MAX_LENGTHS = { title: 200, author: 100, genre: 100, description: 2000, content: 500000, name: 100, email: 254, subject: 300, message: 5000, comment: 2000 };
const validateLengths = (fields) => {
  for (const [key, value] of Object.entries(fields)) {
    if (value && MAX_LENGTHS[key] && String(value).length > MAX_LENGTHS[key])
      return `'${key}' exceeds maximum length of ${MAX_LENGTHS[key]} characters.`;
  }
  return null;
};

// ─── AUTH ──────────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  const match = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!match) return res.status(401).json({ error: "Wrong password" });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// ─── BOOKS (public) ────────────────────────────────────────────────────────
app.get("/api/books", async (req, res) => {
  const { data, error } = await supabase.from("books").select("*").eq("published", true).order("id", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── BOOKS (admin) ─────────────────────────────────────────────────────────
app.get("/api/admin/books", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("books").select("*").order("id", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/admin/books", authMiddleware, async (req, res) => {
  const payload = sanitizeBookPayload(req.body);
  const validationError = validateLengths(payload);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!payload.title) return res.status(400).json({ error: "Title is required" });
  const { data, error } = await supabase.from("books").insert([{ ...payload, downloads: 0, views: 0 }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/admin/books/:id", authMiddleware, async (req, res) => {
  const payload = sanitizeBookPayload(req.body);
  const validationError = validateLengths(payload);
  if (validationError) return res.status(400).json({ error: validationError });
  const { ...safeFields } = payload;
  if (!safeFields.title) return res.status(400).json({ error: "Title is required" });
  const { data, error } = await supabase
    .from("books")
    .update(safeFields)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/books/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("books").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.patch("/api/admin/books/:id/publish", authMiddleware, async (req, res) => {
  const { data: book } = await supabase.from("books").select("published").eq("id", req.params.id).single();
  if (!book) return res.status(404).json({ error: "Not found" });
  const { data, error } = await supabase.from("books").update({ published: !book.published }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── VIEW TRACKING ─────────────────────────────────────────────────────────
app.patch("/api/books/:id/view", async (req, res) => {
  await supabase.rpc("increment_views", { book_id: Number(req.params.id) });
  res.json({ ok: true });
});

// ─── COVER UPLOAD (Supabase Storage) ──────────────────────────────────────
app.post("/api/admin/upload-cover", authMiddleware, upload.single("cover"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const filename = `cover-${Date.now()}.${req.file.mimetype.split("/")[1]}`;
  const { error } = await supabase.storage.from("covers").upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: { publicUrl } } = supabase.storage.from("covers").getPublicUrl(filename);
  res.json({ url: publicUrl });
});

// ─── FREE BOOK DOWNLOAD ────────────────────────────────────────────────────
app.get("/api/books/:id/download", async (req, res) => {
  const { data: book } = await supabase.from("books").select("*").eq("id", req.params.id).eq("published", true).eq("price", 0).single();
  if (!book) return res.status(404).json({ error: "Not found or not free" });
  try {
    const pdfBytes = await generateBookPDF(book);
    await supabase.from("books").update({ downloads: (book.downloads || 0) + 1 }).eq("id", book.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${book.title.replace(/\s+/g, "_")}_OpenScroll.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("PDF generation error:", err.message);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ─── PAYSTACK: INITIALIZE ──────────────────────────────────────────────────
app.post("/api/payment/initialize", async (req, res) => {
  const { email, name, bookId, amount } = req.body;
  if (!email || !bookId || !amount) return res.status(400).json({ error: "Missing fields" });
  if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    const response = await axios.post("https://api.paystack.co/transaction/initialize", {
      email, amount: Math.round(amount * 100), currency: "GHS",
      metadata: { bookId, name, email },
      callback_url: `${FRONTEND_URL}?payment=success`,
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Payment initialization failed", detail: err.message });
  }
});

// ─── PAYSTACK: VERIFY ──────────────────────────────────────────────────────
app.post("/api/payment/verify", async (req, res) => {
  const { reference, bookId } = req.body;
  if (!reference || !bookId) return res.status(400).json({ error: "Missing fields" });

  // Idempotency check
  const { data: usedRef } = await supabase.from("used_payment_refs").select("reference").eq("reference", reference).single();
  if (usedRef) {
    const { data: existingOrder } = await supabase.from("orders").select("*").eq("reference", reference).single();
    return res.json({ ok: true, order: existingOrder, alreadyProcessed: true });
  }

  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });
    const tx = response.data.data;
    const { status, metadata, customer } = tx;
    if (status !== "success") return res.status(400).json({ error: "Payment not successful" });
    if (Number(metadata?.bookId) !== Number(bookId)) {
      return res.status(400).json({ error: "Book/payment mismatch" });
    }

    const { data: book } = await supabase.from("books").select("*").eq("id", Number(bookId)).single();
    if (!book) return res.status(404).json({ error: "Book not found" });
    const expectedAmount = Math.round(toNumber(book.price, 0) * 100);
    if (tx.amount !== expectedAmount || tx.currency !== "GHS") {
      return res.status(400).json({ error: "Amount or currency mismatch" });
    }

    const orderData = {
      bookId: book.id, bookTitle: book.title,
      email: customer.email, name: metadata.name || customer.email,
      amount: response.data.data.amount / 100,
      currency: response.data.data.currency,
      reference, emailDelivered: false,
      paidAt: new Date().toISOString(),
    };

    const { data: order } = await supabase.from("orders").insert([orderData]).select().single();
    await supabase.from("used_payment_refs").insert([{ reference }]);
    await supabase.from("books").update({ downloads: (book.downloads || 0) + 1 }).eq("id", book.id);

    try {
      const pdfBytes = await generateBookPDF(book);
      await sendBookEmail(customer.email, metadata.name || "Beloved", book, pdfBytes);
      await supabase.from("orders").update({ emailDelivered: true }).eq("reference", reference);
    } catch (emailErr) {
      console.error(`[DELIVERY FAILURE] Order for ${customer.email}:`, emailErr.message);
    }

    res.json({ ok: true, order });
  } catch (err) {
    console.error("Payment verify error:", err.response?.data || err.message);
    res.status(500).json({ error: "Verification failed", detail: err.message });
  }
});

// ─── ADMIN: FAILED DELIVERIES ──────────────────────────────────────────────
app.get("/api/admin/orders/failed-deliveries", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("orders").select("*").eq("emailDelivered", false);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── ADMIN: RESEND BOOK EMAIL ──────────────────────────────────────────────
app.post("/api/admin/orders/:id/resend", authMiddleware, async (req, res) => {
  const { data: order } = await supabase.from("orders").select("*").eq("id", req.params.id).single();
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { data: book } = await supabase.from("books").select("*").eq("id", order.bookId).single();
  if (!book) return res.status(404).json({ error: "Book not found" });
  try {
    const pdfBytes = await generateBookPDF(book);
    await sendBookEmail(order.email, order.name, book, pdfBytes);
    await supabase.from("orders").update({ emailDelivered: true }).eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Resend failed", detail: err.message });
  }
});

// ─── ADMIN: ALL ORDERS ─────────────────────────────────────────────────────
app.get("/api/admin/orders", authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const from = (page - 1) * limit;
  const { data, error, count } = await supabase.from("orders").select("*", { count: "exact" }).order("paidAt", { ascending: false }).range(from, from + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: data, total: count, page, limit, pages: Math.ceil(count / limit) });
});

// ─── NEWSLETTER SIGNUP ──────────────────────────────────────────────────────
app.post("/api/newsletter", async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const validationError = validateLengths({ email, name: name || "" });
  if (validationError) return res.status(400).json({ error: validationError });

  const { error } = await supabase.from("newsletter").insert([{ email, name: name || "" }]);
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Already subscribed" });
    return res.status(500).json({ error: error.message });
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: "✦ Welcome to The Open Scroll Newsletter",
      html: baseEmailHtml(`
        <div style="font-size:18px;margin-bottom:16px;">Welcome, ${name || "Beloved"}!</div>
        <p style="color:#8a7870;line-height:1.9;margin-bottom:24px;">
          Thank you for subscribing. You will now receive updates about new books, prophetic words, and divine encounters.
        </p>
        <p style="color:#4a3a5a;font-size:12px;">
          To unsubscribe, <a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color:#c9a84c;">click here</a>.
        </p>
      `),
    });
  } catch (emailErr) {
    console.error("Welcome email error:", emailErr.message);
  }

  res.json({ ok: true });
});

// ─── NEWSLETTER UNSUBSCRIBE ────────────────────────────────────────────────
app.delete("/api/newsletter/unsubscribe", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    const { error } = await supabase.from("newsletter").delete().eq("email", email);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: GET SUBSCRIBERS ────────────────────────────────────────────────
app.get("/api/admin/newsletter", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("newsletter").select("*").order("subscribedAt", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── ADMIN: SEND NEWSLETTER BLAST ─────────────────────────────────────────
app.post("/api/admin/newsletter/send", authMiddleware, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: "Subject and message required" });

  const { data: subscribers } = await supabase.from("newsletter").select("email, name");
  if (!subscribers || subscribers.length === 0) return res.json({ ok: true, sent: 0, failed: 0, total: 0 });

  let sent = 0, failed = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    const emails = batch.map((sub) => ({
      from: EMAIL_FROM,
      to: sub.email,
      subject,
      html: baseEmailHtml(`
        <div style="color:#8a7870;line-height:1.9;margin-bottom:24px;">${message}</div>
        <p style="color:#4a3a5a;font-size:12px;">
          To unsubscribe, <a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(sub.email)}" style="color:#c9a84c;">click here</a>.
        </p>
      `),
    }));

    try {
      await resend.batch.send(emails);
      sent += emails.length;
    } catch (err) {
      console.error("Batch send error:", err.message);
      failed += emails.length;
    }

    if (i + BATCH_SIZE < subscribers.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  res.json({ ok: true, sent, failed, total: subscribers.length });
});

// ─── REVIEWS ───────────────────────────────────────────────────────────────
app.get("/api/books/:id/reviews", async (req, res) => {
  const { data, error } = await supabase.from("reviews").select("*").eq("bookId", req.params.id).order("createdAt", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/books/:id/reviews", async (req, res) => {
  const { name, rating, comment } = req.body;
  if (!name || !rating || !comment) return res.status(400).json({ error: "All fields required" });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });
  const validationError = validateLengths({ name, comment });
  if (validationError) return res.status(400).json({ error: validationError });
  const { data, error } = await supabase.from("reviews").insert([{ bookId: Number(req.params.id), name, rating: Number(rating), comment }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/reviews/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("reviews").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── INQUIRIES ─────────────────────────────────────────────────────────────
app.post("/api/inquiries", async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !subject || !message) return res.status(400).json({ error: "All fields required" });
  const validationError = validateLengths({ name, email, subject, message });
  if (validationError) return res.status(400).json({ error: validationError });

  const { data: inquiry, error } = await supabase.from("inquiries").insert([{ name, email, subject, message, status: "new" }]).select().single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: `✦ We received your message: ${subject}`,
      html: baseEmailHtml(`
        <div style="font-size:18px;margin-bottom:16px;">Dear ${name},</div>
        <p style="color:#8a7870;line-height:1.9;">
          Thank you for reaching out. We have received your inquiry and will respond as soon as possible.
        </p>
      `),
    });
  } catch (err) {
    console.error("Inquiry email error:", err.message);
  }

  res.json({ ok: true, inquiry });
});

app.get("/api/admin/inquiries", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("inquiries").select("*").order("createdAt", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/admin/inquiries/:id", authMiddleware, async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase.from("inquiries").update({ status }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/inquiries/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("inquiries").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── SERIES ────────────────────────────────────────────────────────────────
app.get("/api/series", async (req, res) => {
  const { data, error } = await supabase.from("series").select("*").order("createdAt", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/admin/series", authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Series name required" });
  const { data, error } = await supabase.from("series").insert([{ name, description }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/admin/series/:id", authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Series name required" });
  const { data, error } = await supabase.from("series").update({ name, description }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/admin/series/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("series").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── WISHLIST ──────────────────────────────────────────────────────────────
app.post("/api/wishlist", async (req, res) => {
  const { bookId } = req.body;
  const sessionId = req.headers["x-session-id"];
  if (!bookId) return res.status(400).json({ error: "Book ID required" });
  if (!sessionId) return res.status(400).json({ error: "Session ID required" });
  const { error } = await supabase.from("wishlists").insert([{ bookId: Number(bookId), sessionId }]);
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Already in wishlist" });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

app.get("/api/wishlist", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId) return res.json([]);
  try {
    const { data, error } = await supabase
      .from("wishlists")
      .select("bookId, books(*)")
      .eq("sessionId", sessionId);
    if (error) throw error;
    const books = (data || [])
      .map(row => row.books)
      .filter(Boolean)
      .map(b => ({ ...b, price: Number(b.price) }));
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/wishlist/:bookId", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId) return res.status(400).json({ error: "Session ID required" });
  const { error } = await supabase.from("wishlists").delete().eq("bookId", Number(req.params.bookId)).eq("sessionId", sessionId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── STATISTICS ────────────────────────────────────────────────────────────
app.get("/api/admin/statistics", authMiddleware, async (req, res) => {
  const [
    { data: books },
    { data: orders },
    { data: newsletter },
    { data: reviews },
    { count: totalInquiries },
  ] = await Promise.all([
    supabase.from("books").select("*"),
    supabase.from("orders").select("*"),
    supabase.from("newsletter").select("id", { count: "exact" }),
    supabase.from("reviews").select("rating"),
    supabase.from("inquiries").select("*", { count: "exact", head: true }),
  ]);

  const totalRevenue = (orders || []).reduce((s, o) => s + Number(o.amount), 0);
  const totalDownloads = (books || []).reduce((s, b) => s + (b.downloads || 0), 0);
  const totalViews = (books || []).reduce((s, b) => s + (b.views || 0), 0);
  const avgRating = reviews?.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(2) : 0;
  const booksWithDownloads = (books || []).filter((b) => b.downloads > 0);
  const topBook = booksWithDownloads.length ? booksWithDownloads.reduce((top, b) => b.downloads > top.downloads ? b : top) : null;
  const undeliveredOrders = (orders || []).filter((o) => o.emailDelivered === false).length;

  res.json({
    totalRevenue: totalRevenue.toFixed(2),
    totalDownloads,
    totalViews,
    avgRating,
    topBook,
    recentOrders: (orders || []).slice(-5).reverse(),
    subscriberGrowth: newsletter?.length || 0,
    totalBooks: books?.length || 0,
    totalReviews: reviews?.length || 0,
    totalInquiries: totalInquiries || 0,
    undeliveredOrders,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.startsWith("CORS:")) {
    return res.status(403).json({ error: err.message });
  }
  return res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => console.log(`✦ The Open Scroll running on http://localhost:${PORT}`));