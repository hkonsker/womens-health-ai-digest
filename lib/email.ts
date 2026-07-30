/**
 * lib/email.ts
 *
 * Delivery via Resend. Free tier covers a weekly send comfortably.
 *
 * Required env:
 *   RESEND_API_KEY      from resend.com
 *   DIGEST_TO_EMAILS    comma-separated recipients
 * Optional:
 *   DIGEST_FROM_EMAIL   defaults to Resend's test sender, which only delivers
 *                       to the address that owns the Resend account
 */

import { Resend } from "resend";

export interface SendResult {
  sent: boolean;
  reason?: string;
  id?: string;
}

export async function sendDigestEmail(subject: string, html: string): Promise<SendResult> {
  const recipients = (process.env.DIGEST_TO_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (!process.env.RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY is not set" };
  if (recipients.length === 0) return { sent: false, reason: "DIGEST_TO_EMAILS is not set" };

  const from = process.env.DIGEST_FROM_EMAIL ?? "onboarding@resend.dev";
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({ from, to: recipients, subject, html });
  if (error) return { sent: false, reason: `${error.name}: ${error.message}` };

  return { sent: true, id: data?.id };
}
