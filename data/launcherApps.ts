export type LauncherAppStatus = "ready" | "coming-soon";

/**
 * Data-driven launcher entries. Adding a future HomeworkStudio app is just adding an entry
 * here — no permission system yet (enabled is a static flag for now), but the shape already
 * has what a later per-user permission check would need to decide visibility.
 */
export type LauncherApp = Readonly<{
  id: string;
  title: string;
  version?: string;
  logo: string;
  route: string;
  status: LauncherAppStatus;
  enabled: boolean;
  cta?: string;
}>;

export const launcherApps: readonly LauncherApp[] = [
  {
    id: "hws-easy",
    title: "HWS Easy",
    version: "v1.0",
    logo: "/logo/hws_easy_logo.png",
    route: "",
    status: "coming-soon",
    enabled: false,
  },
  {
    id: "abf-generator",
    title: "ABF Generator",
    logo: "/logo/abf_generator_logo.png",
    route: "/abf",
    status: "ready",
    enabled: true,
    cta: "Vstoupit do generátoru",
  },
];
