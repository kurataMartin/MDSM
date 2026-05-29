"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { logoutUser } from "@/app/actions/auth";
import BrokerDashboard from "@/components/dashboards/broker-dashboard";

export default function BrokerDashboardPage() {
  const [user, setUser] = useState(null);
  const router = useRouter();

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (!storedUser) {
      router.push("/");
      return;
    }
    try {
      setUser(JSON.parse(storedUser));
    } catch {
      router.push("/");
    }
  }, [router]);

  async function handleLogout() {
    localStorage.removeItem("user");
    localStorage.removeItem("auth_token");
    await logoutUser();
    router.push("/");
  }

  if (!user) return null;

  return <BrokerDashboard user={user} onLogout={handleLogout} />;
}
