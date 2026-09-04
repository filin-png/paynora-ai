-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'SUPPORT_REQUEST_SUBMITTED';

-- CreateTable
CREATE TABLE "support_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_requests_organizationId_createdAt_idx" ON "support_requests"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
