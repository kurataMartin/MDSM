"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import KycPage from "../../components/auth/kyc-page";

export default function Kyc() {
  const router = useRouter();

  const [session, setSession] = useState(null);
  const [isChecking, setIsChecking] = useState(true);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    console.log("[KYC WRAPPER] Checking session...");

    const storedUser = localStorage.getItem("tempUser") || localStorage.getItem("user");

    if (!storedUser) {
      console.warn("[KYC WRAPPER] No session found → redirecting to register");
      setError("No active registration session. Redirecting...");
      setTimeout(() => router.replace("/register"), 1500);
      setIsChecking(false);
      return;
    }

    try {
      const parsedUser = JSON.parse(storedUser);

      if (!parsedUser || !parsedUser.id) {
        console.error("[KYC WRAPPER] Invalid session object");
        localStorage.removeItem("user");
        localStorage.removeItem("tempUser");
        router.replace("/register");
        return;
      }

      // Optional: If user already has kyc_status = submitted/approved, go to dashboard
      if (parsedUser.kyc_status === "submitted" || parsedUser.kyc_status === "approved") {
        const dashboard = getDashboardRoute(parsedUser.role);
        console.log("[KYC WRAPPER] KYC already submitted → redirecting to dashboard");
        router.replace(dashboard);
        return;
      }

      setSession(parsedUser);
    } catch (err) {
      console.error("[KYC WRAPPER] Failed to parse session:", err);
      localStorage.removeItem("user");
      localStorage.removeItem("tempUser");
      router.replace("/register");
    } finally {
      setIsChecking(false);
    }
  }, [router]);

  const getDashboardRoute = (role) => {
    const defaultDashboards = {
      investor: "/dashboards/investor-dashboard",
      broker: "/dashboards/broker-dashboard",
      issuer: "/dashboards/issuer-dashboard",
      regulator: "/dashboards/regulator-dashboard",
      admin: "/dashboards/admin-dashboard",
    };
    return defaultDashboards[role?.toLowerCase()] || "/dashboards";
  };

  if (isChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Checking authentication…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  const userRole = session.role?.toLowerCase() || "investor";
  const targetDashboard = getDashboardRoute(userRole);

  // Success / under-review screen shown after a successful KYC submission,
  // then auto-redirects to the user's dashboard.
  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md rounded-2xl border border-emerald-500/20 bg-card p-8 text-center shadow-xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
            <svg className="h-8 w-8 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-foreground">KYC Submitted Successfully</h1>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            Your documents have been received and are now <span className="font-semibold text-foreground">under review</span>.
            Please wait for an administrator to approve your verification. You will be
            notified once your account is approved.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Taking you to your dashboard…
          </p>
          <div className="mt-5 flex justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-500" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <KycPage
      user={session}
      targetDashboard={targetDashboard}
      onComplete={() => {
        console.log("[KYC WRAPPER] onComplete called");

        // Persist user with submitted status so the form is never shown again
        // and the dashboard pages have a valid session object.
        try {
          const tempUser = localStorage.getItem("tempUser");
          const base = tempUser ? JSON.parse(tempUser) : (session || {});
          const merged = { ...base, kyc_status: "submitted" };
          localStorage.setItem("user", JSON.stringify(merged));
          localStorage.removeItem("tempUser");
        } catch (e) {
          console.warn("[KYC WRAPPER] Could not persist user:", e);
        }

        // Show the "under review" screen, then redirect to the dashboard.
        setSubmitted(true);
        const finalDashboard = getDashboardRoute(userRole);
        setTimeout(() => { window.location.href = finalDashboard; }, 2600);
      }}
    />
  );
}