import { AuthProvider } from './context/AuthContext';
import { ChatProvider } from './context/ChatContext';
import HomePage from './pages/HomePage';
import ChatWidget from './components/ChatWidget';

export default function App() {
  // Spec 550: AuthProvider resolves the SSO identity (GET /api/auth/me) and
  // must wrap ChatProvider, which adopts the authenticated email as user_id.
  return (
    <AuthProvider>
      <ChatProvider>
        <HomePage />
        <ChatWidget />
      </ChatProvider>
    </AuthProvider>
  );
}
