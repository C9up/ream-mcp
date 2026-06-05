import { bus } from "fake-ream";
import { UserRegistered } from "./UserRegistered";

bus.subscribe("user.deleted", (event) => {
	// cleanup
});

export function emitWelcome(userId: string) {
	bus.emit(new UserRegistered(userId));
}

export function emitGoodbye(userId: string) {
	bus.dispatch("user.goodbye", { userId });
}
