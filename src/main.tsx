
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/index.css";

const ASSETMATE_DIGITAL_WATERMARK = "202606151006";
document.documentElement.dataset.assetmateWatermark = ASSETMATE_DIGITAL_WATERMARK;

createRoot(document.getElementById("root")!).render(<App />);
