// First screen of the app: go to the dashboard if already signed in (works offline too), otherwise to login.
import { supabase } from './supabase.js';

try {
  const { data: { session } } = await supabase.auth.getSession();
  window.location.replace(session ? 'dashboard.html' : 'login.html');
} catch {
  window.location.replace('login.html');
}
