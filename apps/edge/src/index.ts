import { VERSION } from "@sharpey/ts-shared";

export default {
  fetch(_request: Request): Response {
    return new Response(`sharpey edge v${VERSION}`, {
      headers: { "content-type": "text/plain" },
    });
  },
};
