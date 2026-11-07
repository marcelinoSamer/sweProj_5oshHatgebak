import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { f10PersonalDataColumnsStayInTheirSchema, PERSONAL_DATA_SCHEMA } from '../../../fitness/f10-personal-data-columns-stay-in-their-schema';
import { columnsDeclaredIn } from '../../../fitness/support/sql-columns';
import { createAccountsWorld } from './testing/accounts-world';

/** Task A2: names, phones, plates and cars live only in the personal-data store; everything else holds a reference. */
describe('A2 the personal-data store', () => {
  const repositoryRoot = process.cwd();

  it('finds no name, phone or plate column outside the personal_data schema (fitness function F10)', async () => {
    const result = await f10PersonalDataColumnsStayInTheirSchema(repositoryRoot);
    expect(result.violations).toEqual([]);
    console.log(`A2 report: columns scanned ${result.checked}; violations ${result.violations.length}`);
  });

  it('declares the name, phone and plate columns of this area inside personal_data', async () => {
    const migrationsFolder = path.join(repositoryRoot, 'db', 'migrations');
    const files = (await readdir(migrationsFolder)).filter((file) => file.endsWith('.sql'));
    const columns = (await Promise.all(files.map(async (file) => columnsDeclaredIn(await readFile(path.join(migrationsFolder, file), 'utf8'))))).flat();
    const personalColumns = columns.filter((column) => ['display_name', 'phone', 'plate'].includes(column.column));
    expect(personalColumns.map((column) => column.column).sort()).toEqual(['display_name', 'phone', 'plate']);
    expect(personalColumns.every((column) => column.schema === PERSONAL_DATA_SCHEMA)).toBe(true);
  });

  it('keeps the name and phone in the personal-data store and only a reference in the people table', async () => {
    const { accounts, stores } = createAccountsWorld();
    const created = await accounts.personalData.createPerson('self registration', 'driver', '010 1234 5678', '  Mona   Adel ');
    if (!created.ok) {
      throw new Error(`expected the driver to be created, got ${created.error}`);
    }
    const person = await stores.people.find(created.value);
    expect(person).toEqual({ personId: created.value, role: 'driver', status: 'active', erased: false });
    expect(JSON.stringify(person)).not.toMatch(/Mona|1012345678/);
    expect(await stores.personalData.detailsOf(created.value)).toEqual({
      personRef: created.value,
      displayName: 'Mona Adel',
      phone: '+201012345678',
    });
  });

  it('refuses a second person with the same phone, whatever its spelling', async () => {
    const { accounts } = createAccountsWorld();
    await accounts.personalData.createPerson('self registration', 'driver', '01012345678', 'Mona Adel');
    const again = await accounts.personalData.createPerson('self registration', 'driver', '+20 101 234 5678', 'Someone Else');
    expect(again).toEqual({ ok: false, error: 'phone already registered' });
  });

  it('refuses a phone that is not an Egyptian mobile number and an empty name', async () => {
    const { accounts } = createAccountsWorld();
    expect(await accounts.personalData.createPerson('self registration', 'driver', '12345', 'Mona Adel')).toEqual({ ok: false, error: 'invalid phone' });
    expect(await accounts.personalData.createPerson('self registration', 'driver', '01012345678', '   ')).toEqual({ ok: false, error: 'invalid name' });
  });
});

describe('A1 who may create whom', () => {
  it('lets a driver register themself but nobody register themself as staff', async () => {
    const { accounts } = createAccountsWorld();
    expect((await accounts.personalData.createPerson('self registration', 'driver', '01011111111', 'Driver')).ok).toBe(true);
    expect(await accounts.personalData.createPerson('self registration', 'attendant', '01022222222', 'Attendant')).toEqual({
      ok: false,
      error: 'not allowed to create this role',
    });
  });

  it('follows the hierarchy: the Chair creates members, a member creates attendants but not members', async () => {
    const { accounts } = createAccountsWorld();
    const chair = await accounts.bootstrapChair('01000000000', 'The Chair');
    if (!chair.ok) {
      throw new Error(chair.error);
    }
    const member = await accounts.personalData.createPerson(chair.value, 'member', '01111111111', 'A Member');
    if (!member.ok) {
      throw new Error(member.error);
    }
    expect((await accounts.personalData.createPerson(member.value, 'attendant', '01222222222', 'An Attendant')).ok).toBe(true);
    expect(await accounts.personalData.createPerson(member.value, 'member', '01533333333', 'Another Member')).toEqual({
      ok: false,
      error: 'not allowed to create this role',
    });
  });
});
