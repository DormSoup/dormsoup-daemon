import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const DORMSOUP_SMTP_TRANSPORT = nodemailer.createTransport({
  host: "outgoing.mit.edu",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_KERB?.replace("@mit.edu", ""),
    pass: process.env.SMTP_PASS
  }
});

export const DORMSOUP_SENDER = "DormSoup <dormsoup@mit.edu>";

type SendEmailOptions = {
  to: string;
  subject: string;
  inReplyTo?: string;
} & ({ text: string } | { html: string });

/**
 * Sends an email using the configured SMTP transport.
 *
 * @param opts - The options for the email to be sent, including recipient, subject, and content.
 * @returns A promise that resolves when the email has been sent.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  await DORMSOUP_SMTP_TRANSPORT.sendMail({ ...opts, from: DORMSOUP_SENDER });
}
