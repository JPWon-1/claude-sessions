import { Sidebar } from "@/components/Sidebar";
import type { ReactNode } from "react";
import { Suspense } from "react";

export default function MainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <Suspense fallback={null}>
        <Sidebar />
      </Suspense>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
