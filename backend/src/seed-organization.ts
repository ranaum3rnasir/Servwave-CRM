/**
 * Fills in the estimate boilerplate for the first demo organization.
 *
 * The text below is generic sample copy written for this development
 * environment. It is not legal advice and is not any company's real terms - it
 * exists so estimate and invoice PDFs render with realistic-looking blocks of
 * text instead of empty sections.
 */
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();
const prisma = new PrismaClient();
const DEMO_ORG_ONE_ID = '00000000-0000-0000-0000-000000000001';

const COMPANY = 'ServWave Demo One';

const TERMS = `Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.`;

const NOTES = `1. Any change in product quantity or labor that is not qualified in this estimate will be additionally charged.

2. The warranty provided by ${COMPANY} applies only to parts, materials, and hardware supplied and installed by our company. Any alterations, modifications, or repairs performed by third parties will result in the immediate voidance of the warranty.

**Coverage:**
This warranty is valid for 90 days from the date of installation completion. Accessories (e.g., cables, connectors, moldings) are covered for 30 days.

**Exclusions:**
The warranty will be voided under the following circumstances:
- Unauthorized modifications or repairs
- Tampering or adjustments
- Damage from misuse or interference
- Acts of vandalism

**Ownership:**
All materials and products remain the property of ${COMPANY} until payment is received in full.

**Service Hours:**
Warranty services are available Monday through Friday, 9:00 AM to 5:00 PM, excluding holidays. After-hours rates apply outside those times.

**Post-Warranty Service:**
After the warranty period expires, any troubleshooting or repair services will be charged at an hourly rate per technician, with additional charges for materials and labor.

3. The customer is responsible for arranging building access for our technicians. Access problems or other work delays will be charged at an hourly rate.

4. Prices are subject to change after 60 days.

5. The purchaser is responsible for any patching, painting, or ceiling tile replacement required as a result of the proposed scope of work.

6. Change orders must be submitted in writing at least 48 hours in advance.`;

const PAYMENT_TERMS = `**Late Payment:** Any invoice amounts remaining unpaid beyond thirty (30) days of invoice date are subject to a late penalty charge of 5% interest per month, or the maximum rate allowed by law, whichever is less.

- 70% due upon acceptance
- 30% upon completion
- No refund on the 70% deposit
- For credit card charges an additional fee of 3.5% will apply
- Prices are subject to change after 60 days`;

async function main() {
  await prisma.organization.update({
    where: { id: DEMO_ORG_ONE_ID },
    data: {
      estimate_terms: TERMS,
      estimate_notes: NOTES,
      estimate_payment_terms: PAYMENT_TERMS,
    },
  });
  console.log('Organization seeded:', DEMO_ORG_ONE_ID);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
