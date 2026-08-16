// The real-money terms, as a page you can link to, bookmark and send to someone.
//
// Deliberately NOT a sheet inside the app: consent is a one-tap notice, and the full text belongs
// somewhere a person can read at their own pace and come back to. It is also the honest place for it
// — a document that only ever appears as a modal the user is trying to dismiss is not a document
// anyone has read.
import Link from "next/link";
import { REAL_TERMS, REAL_TERMS_INTRO, REAL_TERMS_TITLE, REAL_TERMS_VERSION } from "@/lib/real-terms";

export const metadata = { title: "Real money terms · Hedge Fun" };

export default function TermsPage() {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 20px 64px" }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          ← Back to the app
        </Link>

        <h1 style={{ fontFamily: "var(--df)", fontSize: 30, lineHeight: 1.12, margin: "18px 0 0" }}>
          {REAL_TERMS_TITLE}
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.55, marginTop: 10 }}>{REAL_TERMS_INTRO}</p>

        {REAL_TERMS.map((c) => (
          <section key={c.title} style={{ marginTop: 22 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{c.title}</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginTop: 6 }}>{c.body}</p>
          </section>
        ))}

        {/* The version is on the page because acceptance is recorded against it: if this changes, the
            app asks again, and someone comparing what they agreed to needs the number to be visible. */}
        <div style={{ marginTop: 34, paddingTop: 14, borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--muted)" }}>
          Version {REAL_TERMS_VERSION}
        </div>
      </div>
    </div>
  );
}
