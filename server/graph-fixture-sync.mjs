// Offline Graph-shaped synchronization. No credentials, fetch, sockets or send API.
import { randomUUID } from "node:crypto";
import { emailConnection, emailDigest, emailInput, emailOpaqueId, emailSourceId, requireEmail } from "./email-envelope.mjs";
import { graphFolderChanges, normalizeGraphEmail } from "./graph-email.mjs";
import { ServiceError } from "./service-error.mjs";

const fail = (code, message) => { throw new ServiceError(409, code, message); };
const route = (connection, folderId) => "/v1.0/users/" + encodeURIComponent(connection.mailboxId)
  + "/mailFolders/" + encodeURIComponent(emailOpaqueId(folderId)) + "/messages/delta";
