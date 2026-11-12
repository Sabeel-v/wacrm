-- ============================================================================
-- Local development seed. NOT for production.
--   npm run db:seed:local       (after npm run db:migrate:local)
--   npm run db:reset:local      (wipe local D1 + migrate + seed)
--
-- One account with one user per role. Fixed, readable ids so tests and
-- manual checks can reference rows. Login password: see "Logins" below.
-- No whatsapp_config: its tokens
-- must be real ENCRYPTION_KEY ciphertext, so connect a number in Settings.
-- ============================================================================

-- Users (one per role) -------------------------------------------------------
INSERT INTO users (id, email, name, email_verified) VALUES
  ('00000000-0000-4000-8000-000000000001', 'owner@wacrm.test',  'Olivia Owner',  1),
  ('00000000-0000-4000-8000-000000000002', 'admin@wacrm.test',  'Adam Admin',    1),
  ('00000000-0000-4000-8000-000000000003', 'agent@wacrm.test',  'Ava Agent',     1),
  ('00000000-0000-4000-8000-000000000004', 'viewer@wacrm.test', 'Victor Viewer', 1);

INSERT INTO accounts (id, name, owner_user_id, default_currency) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Demo Business', '00000000-0000-4000-8000-000000000001', 'USD');

INSERT INTO profiles (id, user_id, account_id, account_role, full_name, email) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner',  'Olivia Owner',  'owner@wacrm.test'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'admin',  'Adam Admin',    'admin@wacrm.test'),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'agent',  'Ava Agent',     'agent@wacrm.test'),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'viewer', 'Victor Viewer', 'viewer@wacrm.test');

-- Logins (Better Auth credential accounts) ----------------------------------
-- LOCAL TEST CREDENTIALS ONLY. Every seed user signs in with:
--   email:    owner@wacrm.test | admin@wacrm.test | agent@wacrm.test | viewer@wacrm.test
--   password: WacrmDev!2026
-- All four use Better Auth's scrypt hash format.
INSERT INTO auth_accounts (id, user_id, provider_account_id, provider_id, password) VALUES
  ('a5000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'credential', '324ffce750cf437b52bbbcdce8723a40:6bec43591a735969c5cdaba023ecb1ce302d7a9355d13bbe863eb6b78d3aa638b1da26ee88466275a4dbca8bd8cfe2600a7c65ddd931b185c615dd6ddb390f59'),
  ('a5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'credential', '1effdb7092aefd9f26db33bc1e77f1b1:22da97d490170f3a26b64b4f4387b341ec49ee747dd794d3d4d4ea05a98ce0cb547081509855e785e44f256060d4c7833ce2d84b6bf1b5ec89b068765071d39f'),
  ('a5000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', 'credential', 'c2b97d863b3f74283f28b35ea9862186:fa3e70f01bba5fe39504b00ffc197a7d52bd7c5a3276eccb285a15030ba42939ee49a678de3a9d92d918eefa64a0f1b6573410055af89013e95129479c93d708'),
  ('a5000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', 'credential', 'c2b97d863b3f74283f28b35ea9862186:fa3e70f01bba5fe39504b00ffc197a7d52bd7c5a3276eccb285a15030ba42939ee49a678de3a9d92d918eefa64a0f1b6573410055af89013e95129479c93d708');

-- Tags and custom fields -------------------------------------------------------
INSERT INTO tags (id, account_id, user_id, name, color) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'VIP',  '#f59e0b'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Lead', '#3b82f6');

INSERT INTO custom_fields (id, account_id, user_id, field_name, field_type, field_options) VALUES
  ('31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'City', 'select', '{"options":["Dubai","Riyadh","Karachi"]}');

-- Contacts (phone_normalized = phone with every non-digit removed) ------------
INSERT INTO contacts (id, account_id, user_id, phone, phone_normalized, name, email, company) VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '+971 50 123 4567', '971501234567', 'Sara Khan',   'sara@example.com', 'Khan Trading'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '+966-55-765-4321', '966557654321', 'Omar Ali',    NULL,               NULL),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '+92 300 1112233',  '923001112233', 'Hina Raza',   'hina@example.com', 'Raza Foods');

INSERT INTO contact_tags (contact_id, tag_id) VALUES
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002'),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002');

INSERT INTO contact_custom_values (contact_id, custom_field_id, value) VALUES
  ('40000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'Dubai');

INSERT INTO contact_notes (account_id, contact_id, user_id, note_text) VALUES
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'Prefers WhatsApp over email.');

-- Conversations and messages ---------------------------------------------------
INSERT INTO conversations (id, account_id, user_id, contact_id, status, assigned_agent_id, last_message_text, last_message_at, unread_count) VALUES
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'open',    '00000000-0000-4000-8000-000000000003', 'Do you deliver to Dubai Marina?', '2026-11-10T09:05:00.000Z', 1),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'pending', NULL,                                   'Thanks!',                         '2026-11-09T14:30:00.000Z', 0);

INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_type, content_text, message_id, status, created_at) VALUES
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'customer', NULL,                                   'text', 'Hi, is the summer offer still on?', 'wamid.SEED001', 'delivered', '2026-11-10T09:00:00.000Z'),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', 'agent',    '00000000-0000-4000-8000-000000000003', 'text', 'Yes, until the end of the month.',   'wamid.SEED002', 'read',      '2026-11-10T09:02:00.000Z'),
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', 'customer', NULL,                                   'text', 'Do you deliver to Dubai Marina?',    'wamid.SEED003', 'delivered', '2026-11-10T09:05:00.000Z'),
  ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000002', 'customer', NULL,                                   'text', 'Thanks!',                            'wamid.SEED004', 'delivered', '2026-11-09T14:30:00.000Z');

INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji) VALUES
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', 'customer', NULL, '👍');

-- Templates and quick replies --------------------------------------------------
INSERT INTO message_templates (id, account_id, user_id, name, category, language, body_text, status, buttons, sample_values) VALUES
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   'summer_offer', 'Marketing', 'en_US', 'Hi {{1}}, our summer offer ends soon!', 'APPROVED',
   '[{"type":"QUICK_REPLY","text":"Interested"},{"type":"QUICK_REPLY","text":"Stop"}]', '{"body":["Sara"]}');

INSERT INTO quick_replies (account_id, user_id, title, kind, content_text) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'Opening hours', 'text', 'We are open 9am–9pm, Saturday to Thursday.');

-- Pipeline and deal --------------------------------------------------------------
INSERT INTO pipelines (id, account_id, user_id, name) VALUES
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Sales');

INSERT INTO pipeline_stages (id, pipeline_id, name, position, color) VALUES
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'New',        0, '#3b82f6'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', 'Negotiating', 1, '#f59e0b'),
  ('81000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', 'Won',        2, '#22c55e');

INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, conversation_id, assigned_to, title, value_cents, currency, expected_close_date, status) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000003', 'Summer bulk order', 125050, 'USD', '2026-11-30', 'open');

-- Broadcast with mixed recipient statuses (exercises the counter triggers) --
INSERT INTO broadcasts (id, account_id, user_id, name, template_name, template_language, status, total_recipients) VALUES
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   'Summer offer blast', 'summer_offer', 'en_US', 'sent', 3);

INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, whatsapp_message_id, template_params, sent_at, delivered_at, read_at) VALUES
  ('90000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'read',      'wamid.BCAST001', '["Sara"]', '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:05.000Z', '2026-11-08T10:30:00.000Z'),
  ('90000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'delivered', 'wamid.BCAST002', '["Omar"]', '2026-11-08T10:00:01.000Z', '2026-11-08T10:00:06.000Z', NULL),
  ('90000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', 'failed',    NULL,             '["Hina"]', NULL,                       NULL,                       NULL);

-- Automation (tag VIP contacts on keyword) -------------------------------------
INSERT INTO automations (id, account_id, user_id, name, trigger_type, trigger_config, is_active) VALUES
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   'Tag VIP on keyword', 'keyword', '{"keywords":["vip"]}', 1);

INSERT INTO automation_steps (automation_id, step_type, step_config, position) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'add_tag',      '{"tag_id":"30000000-0000-4000-8000-000000000001"}', 0),
  ('a0000000-0000-4000-8000-000000000001', 'send_message', '{"text":"Welcome to VIP!"}',                          1);

-- Flow (draft) ---------------------------------------------------------------------
INSERT INTO flows (id, account_id, user_id, name, status, trigger_type, trigger_config, entry_node_id) VALUES
  ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   'Menu', 'draft', 'keyword', '{"keywords":["menu"]}', 'start');

INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'start', 'start',        '{}',                                   0,   0),
  ('b0000000-0000-4000-8000-000000000001', 'ask',   'send_buttons', '{"text":"How can we help?","buttons":["Prices","Hours"]}', 0, 150),
  ('b0000000-0000-4000-8000-000000000001', 'done',  'end',          '{}',                                   0, 300);

-- Notification for the assigned agent --------------------------------------------
INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'conversation_assigned',
   '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'New conversation assigned', 'Olivia Owner assigned you a conversation with Sara Khan');

-- Knowledge base (exercises the FTS triggers) -----------------------------------
INSERT INTO ai_knowledge_documents (id, account_id, created_by, title, content) VALUES
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   'Delivery policy', 'We deliver across Dubai, including Dubai Marina, within 48 hours. Delivery is free over 200 AED.');

INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content) VALUES
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 0,
   'We deliver across Dubai, including Dubai Marina, within 48 hours. Delivery is free over 200 AED.');
