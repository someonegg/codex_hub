import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
