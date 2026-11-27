-- 0996 · Content check before the event: one scoreboard puzzle can total below zero (−5);
-- say plainly how to enter it (answers ignore the minus sign either way).
update mission_templates
   set clues = jsonb_set(clues, '{decoder,body}', to_jsonb((clues -> 'decoder' ->> 'body') || E'\nA total below zero is entered without the minus sign.'))
 where family = 'cricket' and position('below zero' in clues -> 'decoder' ->> 'body') = 0;
