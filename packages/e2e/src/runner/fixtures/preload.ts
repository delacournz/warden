// Order matters: the fake factories must be registered before the real preload creates the session.
import "./fake-setup";
import "../../preload";
