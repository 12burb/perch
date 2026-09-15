/**
 * The inbox fragment of the message catalog (ADR-0085). Importing this module for its side effect
 * puts its strings in the catalog and its bytes in the importing chunk, so Inbox carries its own
 * vocabulary and the first paint does not.
 */
import messages from "./en.inbox.json" with { type: "json" };
import { addMessages } from "./index.ts";

addMessages("en", messages);
