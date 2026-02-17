import { Route, Routes } from "react-router-dom";
import AuthGuard from "./components/AuthGuard";
import ImportSession from "./components/ImportSession";
import ShareSession from "./components/ShareSession";
import Home from "./pages/Home";
import Login from "./pages/Login";

function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <AuthGuard>
            <Home />
          </AuthGuard>
        }
      />
      <Route
        path="/index.html"
        element={
          <AuthGuard>
            <Home />
          </AuthGuard>
        }
      />
      <Route path="/login" element={<Login />} />
      <Route
        path="/home"
        element={
          <AuthGuard>
            <Home />
          </AuthGuard>
        }
      />
      <Route
        path="/import-session"
        element={
          <AuthGuard>
            <ImportSession />
          </AuthGuard>
        }
      />
      <Route
        path="/share-session"
        element={
          <AuthGuard>
            <ShareSession />
          </AuthGuard>
        }
      />
      <Route
        path="*"
        element={
          <AuthGuard>
            <Home />
          </AuthGuard>
        }
      />
    </Routes>
  );
}

export default App;
