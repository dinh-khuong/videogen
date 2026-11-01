import { createContact, listContacts, type ContactInput } from "@/lib/server/contacts";
import { route, intParam, json, readJson, searchParams } from "@/lib/server/http";

export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  return json(
    listContacts({
      q: p.get("q") || undefined,
      status: p.get("status") || undefined,
      tag: p.get("tag") || undefined,
      due: p.get("due") === "1",
      limit: intParam(p.get("limit")),
      offset: intParam(p.get("offset")),
    }),
  );
});

export const POST = route(async (request: Request) => {
  return json(createContact(await readJson<ContactInput>(request)), 201);
});
