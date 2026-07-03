import { IsMongoId } from 'class-validator';

export class LinkMachineDto {
  @IsMongoId() machineId: string;
}
