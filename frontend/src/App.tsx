import { AuthProvider, useAuth } from './context/AuthContext';
import { ChatProvider } from './context/ChatContext';
import HomePage from './pages/HomePage';
import ChatWidget from './components/ChatWidget';
import LeadGate from './components/LeadGate';

/** Store shell behind the attendee gate. Gate is active only when the server says so
 *  (public AI4 domain, leadGate=true); local/self-deploy renders straight through. */
function GatedApp() {
  const { leadGate, isLoading } = useAuth();
  // Don't flash the gate before we know whether it's needed.
  if (isLoading) return null;
  return (
    <LeadGate enabled={leadGate}>
      <ChatProvider>
        <HomePage />
        <ChatWidget />
      </ChatProvider>
    </LeadGate>
  );
}

export default function App() {
  // Spec 550: AuthProvider resolves the SSO identity (GET /api/auth/me) and
  // must wrap ChatProvider, which adopts the authenticated email as user_id.
  return (
    <AuthProvider>
      <GatedApp />
    </AuthProvider>
  );
}
