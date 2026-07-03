import { Injectable, BadRequestException } from '@nestjs/common';
import { detectBankFormat } from './parsers/format-detector';
import { parseHdfc } from './parsers/hdfc.parser';
import { parseIcici } from './parsers/icici.parser';
import { parseSbi } from './parsers/sbi.parser';
import { parseAxis } from './parsers/axis.parser';
import { parseKotak } from './parsers/kotak.parser';
import { parseYesBank } from './parsers/yes-bank.parser';
import { parseIndusind } from './parsers/indusind.parser';
import { parsePnb } from './parsers/pnb.parser';
import { parseBob } from './parsers/bob.parser';
import { parseGeneric, GenericColumnMapping } from './parsers/generic.parser';
import type { ParseResult, BankFormatKey } from './parsers/normalised-row';

/**
 * BankStatementParserService — single entry point for all bank statement parsing.
 *
 * Wave 3 and Wave 4 consumers should inject this service and call parse() or
 * parseWithFormat(). Individual parser functions must NOT be called directly by
 * consumers (Threat T-13-W2-07: single entry point prevents cross-parser leakage).
 */
@Injectable()
export class BankStatementParserService {
  /**
   * Auto-detect the bank format from the file buffer and filename, then
   * dispatch to the correct parser.
   *
   * If format = 'generic' and no genericMapping is provided, throws
   * BadRequestException with errorCode = 'GENERIC_MAPPING_REQUIRED'.
   * The Wave 4 controller catches this and returns the column-preview
   * structure for the UI to render the column-mapping wizard.
   */
  parse(
    buffer: Buffer,
    filename: string,
    genericMapping?: GenericColumnMapping,
  ): ParseResult {
    const format = detectBankFormat(buffer, filename);
    try {
      switch (format) {
        case 'hdfc':     return parseHdfc(buffer, filename);
        case 'icici':    return parseIcici(buffer, filename);
        case 'sbi':      return parseSbi(buffer, filename);
        case 'axis':     return parseAxis(buffer, filename);
        case 'kotak':    return parseKotak(buffer, filename);
        case 'yes_bank': return parseYesBank(buffer, filename);
        case 'indusind': return parseIndusind(buffer, filename);
        case 'pnb':      return parsePnb(buffer, filename);
        case 'bob':      return parseBob(buffer, filename);
        case 'generic':
          if (!genericMapping) {
            throw new BadRequestException({
              errorCode: 'GENERIC_MAPPING_REQUIRED',
              message: 'Unknown bank format. Provide column mapping.',
            });
          }
          return parseGeneric(buffer, filename, genericMapping);
        default:
          throw new BadRequestException(`Unhandled format: ${format as string}`);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Failed to parse ${format} statement: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Force-parse with an explicit format key (used after user confirms generic
   * column mapping or when the caller knows the bank format upfront).
   */
  parseWithFormat(
    buffer: Buffer,
    filename: string,
    format: BankFormatKey,
    genericMapping?: GenericColumnMapping,
  ): ParseResult {
    switch (format) {
      case 'hdfc':     return parseHdfc(buffer, filename);
      case 'icici':    return parseIcici(buffer, filename);
      case 'sbi':      return parseSbi(buffer, filename);
      case 'axis':     return parseAxis(buffer, filename);
      case 'kotak':    return parseKotak(buffer, filename);
      case 'yes_bank': return parseYesBank(buffer, filename);
      case 'indusind': return parseIndusind(buffer, filename);
      case 'pnb':      return parsePnb(buffer, filename);
      case 'bob':      return parseBob(buffer, filename);
      case 'generic':
        if (!genericMapping) {
          throw new BadRequestException('mapping required for generic');
        }
        return parseGeneric(buffer, filename, genericMapping);
      default:
        throw new BadRequestException(`Unknown format: ${format as string}`);
    }
  }
}
