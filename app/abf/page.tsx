import BoothGenerator from "../../components/BoothGenerator";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
} from "../../lib/auth/session";

export const metadata = {
  title: "Homework Studio | ABF Generator",
};

export default async function AbfGeneratorPage() {
  const cookieStore = await cookies();
  const sessionValid = await verifySessionToken(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
    process.env.APP_SESSION_SECRET,
  );
  if (!sessionValid) {
    redirect(`/login?next=${encodeURIComponent("/abf")}`);
  }
  return <BoothGenerator />;
}
