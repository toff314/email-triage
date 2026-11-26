import { Routes, Route, Navigate } from 'react-router'
import AppLayout from "@/components/AppLayout"
import MailPage from "@/pages/MailPage"
import RulesPage from "@/pages/RulesPage"
import AccountsPage from "@/pages/AccountsPage"
import SettingsPage from "@/pages/SettingsPage"
import { AccountProvider } from "@/lib/accounts"
import Login from "./pages/Login"
import NotFound from "./pages/NotFound"

export default function App() {
  return (
    <AccountProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<MailPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/home" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AccountProvider>
  )
}
