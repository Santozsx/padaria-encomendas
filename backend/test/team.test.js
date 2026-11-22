import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTeamChange } from '../src/services/team.service.js';

const admin = (id) => ({ user_id: id, role: 'admin', active: true });

test('ninguém tira o próprio acesso de admin nem se desativa', () => {
  assert.throws(() => checkTeamChange({ actorId: 'a', target: admin('a'), patch: { role: 'atendimento' }, activeAdmins: 3 }), /próprio acesso/);
  assert.throws(() => checkTeamChange({ actorId: 'a', target: admin('a'), patch: { active: false }, activeAdmins: 3 }), /própria conta/);
});

test('sempre sobra pelo menos um administrador ativo', () => {
  assert.throws(() => checkTeamChange({ actorId: 'a', target: admin('b'), patch: { role: 'cozinha' }, activeAdmins: 1 }), /pelo menos um administrador/);
  assert.doesNotThrow(() => checkTeamChange({ actorId: 'a', target: admin('b'), patch: { role: 'cozinha' }, activeAdmins: 2 }));
});

test('promover alguém a admin e desativar quem não é admin é permitido', () => {
  assert.doesNotThrow(() => checkTeamChange({ actorId: 'a', target: { user_id: 'c', role: 'atendimento', active: true }, patch: { role: 'admin' }, activeAdmins: 1 }));
  assert.doesNotThrow(() => checkTeamChange({ actorId: 'a', target: { user_id: 'c', role: 'cozinha', active: true }, patch: { active: false }, activeAdmins: 1 }));
});
