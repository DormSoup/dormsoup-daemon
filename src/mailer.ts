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
} & ({ text: string } | { html: string });

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  await DORMSOUP_SMTP_TRANSPORT.sendMail({ ...opts, from: DORMSOUP_SENDER });
}
