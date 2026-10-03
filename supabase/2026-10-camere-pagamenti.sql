-- Da eseguire UNA volta in Supabase → SQL Editor → New query → Run.
-- Aggiunge il numero di camere aperte e l'importo già incassato.
-- Si può rieseguire senza danni.
alter table confirmed_bookings add column if not exists rooms smallint;
alter table confirmed_bookings add column if not exists amount_paid numeric default 0;
alter table pending_quotes add column if not exists rooms smallint;

-- Le prenotazioni già salvate: camere dedotte dal numero di ospiti
update confirmed_bookings set rooms = case when coalesce(guests, 2) >= 3 then 2 else 1 end where rooms is null;
-- e l'incassato, per quelle già segnate come saldate
update confirmed_bookings set amount_paid = total where payment_status = 'saldata' and coalesce(amount_paid, 0) = 0 and total is not null;
