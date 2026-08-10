import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();
const prisma = new PrismaClient();
const ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001';

const TERMS = `Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.`;

const NOTES = `1. Any change in products quantity or labor that is not qualified in this estimate will be additionally charged.

2. The warranty provided by Alpha Doors & Security applies only to parts, materials, and hardware supplied and installed by our company. Any alterations, modifications, or repairs performed by third parties or individuals not authorized by Alpha Doors & Security will result in the immediate voidance of the warranty. This includes, but is not limited to:
- The addition of materials or components to the originally installed hardware.

**Coverage:**
The warranty provided by Alpha Doors & Security applies only to parts, materials, and hardware supplied and installed by our company. This warranty is valid for 90 days from the date of installation completion. Accessories (e.g., cables, connectors, moldings) are covered for 30 days.

**Exclusions:**
The warranty will be voided under the following circumstances:
- Unauthorized Modifications or Repairs
- Tampering or Adjustments
- Damage from Misuse or Interference
- Acts of Vandalism

**Ownership:**
All materials and products remain the property of Alpha Doors & Security until payment is received in full.

**Service Hours:**
Warranty services are available Monday through Friday, 9:00 AM to 5:00 PM, excluding holidays. After hours rate apply before and after 9:00am to 5pm.

**Access Control in Door Replacement Project Disclaimer:**
The Company shall not be held responsible for the operation, compatibility, or condition of any existing access control systems, including but not limited to keypads, card readers, electric strikes, magnetic locks, intercoms, or other electronic security devices, whether integrated with the door being installed or located nearby.

**Post-Warranty Service:**
After the warranty period expires, any troubleshooting or repair services will be charged at an hourly rate per technician, with additional charges for materials and labor. Please inquire about our Extended Warranty options for continued coverage.

3. Customer will be responsible for building access arrangements to our technicians. Any access problems or any others work delays will by additional charged by an hourly rate.

4. Prices are subject to change after 60 days.

5. The purchaser shall be responsible for any patching, painting, ceiling tile replacement that may be required as a result of the proposed scope of work.

6. Change Orders: All Change orders should be written and submitted to ALPHA DOORS & SECURITY at least 48 Hours in advance.

7. All equipment will be owned by ALPHA DOORS & SECURITY until the last payment will be Settle. After the Last payment the equipment will by hand over to the client.`;

const PAYMENT_TERMS = `**Late Payment:** Any invoice amounts remaining unpaid beyond thirty (30) days of invoice date are subject to a late penalty charge of 5% interest per month, or the maximum rate allowed by law, whichever is less.

- 70% due upon acceptance
- 30% upon completion
- No refund on 70% deposit
- For credit card charges additional fee of 3.5% will apply
- Prices are subject to change after 60 days`;

async function main() {
  await prisma.organization.update({
    where: { id: ALPHA_ORG_ID },
    data: {
      estimate_terms: TERMS,
      estimate_notes: NOTES,
      estimate_payment_terms: PAYMENT_TERMS,
    },
  });
  console.log('Organization seeded:', ALPHA_ORG_ID);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
