/**
 * Thrown for any AR resource (customer, invoice, payment) looked up by id
 * that either doesn't exist or doesn't belong to the calling organization.
 * Deliberately one error for both causes — the same enumeration-safety
 * reasoning as OrganizationAccessDeniedError (see
 * src/server/tenancy/errors.ts): a cross-tenant id shouldn't get a
 * different response than a nonexistent one.
 */
export class ArResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "ArResourceNotFoundError";
  }
}

export class ArchivedCustomerError extends Error {
  constructor() {
    super("Cannot create an invoice for an archived customer");
    this.name = "ArchivedCustomerError";
  }
}

export class InvoiceCancelledError extends Error {
  constructor() {
    super("Cannot record a payment against a cancelled invoice");
    this.name = "InvoiceCancelledError";
  }
}

export class InvoiceHasPaymentsError extends Error {
  constructor() {
    super("Cannot cancel an invoice that has recorded payments");
    this.name = "InvoiceHasPaymentsError";
  }
}

export class OverpaymentError extends Error {
  constructor(outstandingMinor: bigint) {
    super(`Payment exceeds the outstanding balance (${outstandingMinor} minor units remaining)`);
    this.name = "OverpaymentError";
  }
}

export class DuplicateInvoiceNumberError extends Error {
  constructor() {
    super("An invoice with this number already exists");
    this.name = "DuplicateInvoiceNumberError";
  }
}
