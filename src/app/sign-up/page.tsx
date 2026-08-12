import { AuthLayout } from "@/components/auth/auth-layout";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <AuthLayout>
      <SignUpForm />
    </AuthLayout>
  );
}
