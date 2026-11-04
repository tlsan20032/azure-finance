// Sends email through any SMTP service. Settings come from environment variables.
const nodemailer = require("nodemailer");

const configured = () => Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
let transporter;

function getTransport() {
  if (!transporter) {
    const host = process.env.SMTP_HOST;
    const secure = process.env.SMTP_SECURE === "true"; // true for port 465, false for 587 (STARTTLS)
    const local = ["localhost", "127.0.0.1"].includes(host);
    transporter = nodemailer.createTransport({
      host, port: Number(process.env.SMTP_PORT || 587), secure,
      requireTLS: !secure && !local, // never send the password unencrypted
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
  }
  return transporter;
}

function sendMail({ to, subject, text, attachments }) {
  return getTransport().sendMail({
    from: process.env.MAIL_FROM, to, subject, text, attachments,
    bcc: process.env.MAIL_BCC || undefined,
    replyTo: process.env.MAIL_REPLY_TO || undefined,
  });
}
module.exports = { configured, sendMail };
