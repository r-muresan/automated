-- AlterEnum
ALTER TYPE "WorkflowStepType" ADD VALUE 'switch_tab';

-- AlterTable
ALTER TABLE "WorkflowStep" ADD COLUMN "tabIndex" INTEGER;
