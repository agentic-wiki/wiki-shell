import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "@/App";
import { takeTokenFromUrl } from "@/token";
// Self-hosted: Vite fingerprints the woff2 into ui/dist, so the binary carries
// the typeface and the page still loads nothing from a network.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";

// BrowserRouter, never a hash router: the fragment carries heading anchors
// (/wiki/notes/a.md#a-heading_here) and the API token the server prints
// (/#t=…), so it cannot also carry the route.
//
// The token is taken out of the address before React starts, so the router is
// built with an address that no longer has one: `history.replaceState` does not
// update the router's location, so a fragment read later would stay in its state
// (and be chased as a heading anchor) even once the address bar shows it gone.
// See `token.ts`; later fragment navigations are handled by `App`.
takeTokenFromUrl();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
