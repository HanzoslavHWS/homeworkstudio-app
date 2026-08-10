import BoothGenerator from "../components/BoothGenerator";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
} from "../lib/auth/session";

export default async function Home() {
  const cookieStore = await cookies();
  const sessionValid = await verifySessionToken(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
    process.env.APP_SESSION_SECRET,
  );
  if (!sessionValid) {
    redirect("/login");
  }
  return <BoothGenerator />;
}
