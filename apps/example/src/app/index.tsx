import { Redirect } from "expo-router";
import { useSession } from "@/modules/session/contexts/session.context";

export default function Index() {
	const { session } = useSession();
	return <Redirect href={session ? "/todos" : "/welcome"} />;
}
