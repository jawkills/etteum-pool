import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { WebSocketProvider } from "./hooks/useWebSocket";
import { Toaster } from "./components/ui/toast";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <WebSocketProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster />
    </WebSocketProvider>
  </ThemeProvider>
);
