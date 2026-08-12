-- AlterEnum
ALTER TYPE "CommunicationChannel" ADD VALUE 'TELEGRAM';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "preferredCommunicationChannel" "CommunicationChannel",
ADD COLUMN     "telegramChatId" TEXT;
