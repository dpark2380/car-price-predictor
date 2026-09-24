-- Data validation suite, run before each retrain by db/validation.py.
-- Each statement returns one row; every column is a count that should be 0
-- (or explainable). Bounds mirror training_pool_v in db/models.py.

-- Required fields missing (such rows are dropped from training)
SELECT
    SUM(price   IS NULL) AS null_price,
    SUM(mileage IS NULL) AS null_mileage,
    SUM(year    IS NULL) AS null_year,
    SUM(make    IS NULL) AS null_make,
    SUM(model   IS NULL) AS null_model
FROM car_listings;

-- Out-of-bound values (excluded from training, still scored if price > 500)
SELECT
    SUM(price   NOT BETWEEN 3000 AND 100000) AS price_out_of_bounds,
    SUM(mileage NOT BETWEEN 0 AND 400000)    AS mileage_out_of_bounds
FROM car_listings;

-- Same VIN stored under different listing_ids (listing_id is the only dedup key)
SELECT
    COUNT(*)            AS duplicate_vins,
    COALESCE(SUM(n), 0) AS duplicate_vin_rows
FROM (
    SELECT vin, COUNT(DISTINCT listing_id) AS n
    FROM car_listings
    WHERE vin IS NOT NULL AND vin <> ''
    GROUP BY vin
    HAVING n > 1
);

-- Predictions whose listing is missing or no longer active
SELECT COUNT(*) AS predictions_without_active_listing
FROM predictions p
LEFT JOIN car_listings l ON l.listing_id = p.listing_id AND l.is_active = 1
WHERE l.id IS NULL;
