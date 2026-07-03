import { Module } from '@nestjs/common';
import { PaymentReceiptModule } from './payment-receipt/payment-receipt.module';
import { PartyLedgerModule } from './party-ledger/party-ledger.module';
import { LateFeeModule } from './late-fee/late-fee.module';
import { BrokerCommissionModule } from './broker-commission/broker-commission.module';

@Module({
  imports: [PaymentReceiptModule, PartyLedgerModule, LateFeeModule, BrokerCommissionModule],
  exports: [PaymentReceiptModule, PartyLedgerModule, LateFeeModule, BrokerCommissionModule],
})
export class PaymentsModule {}
