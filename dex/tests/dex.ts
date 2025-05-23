import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Dex } from "../target/types/dex";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getMint,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

// Initialize the Anchor provider
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Dex as Program<Dex>;
const DEFAULT_AIRDROP_SOL = 2;

describe("DEX tests", () => {
  // Test accounts
  let adminWallet: anchor.Wallet;
  let admin: Keypair;
  let dexStatePda: PublicKey;
  let unauthorizedAttacker: Keypair;
  let poolOwner: Keypair;
  let feeCollector: Keypair;

  // Token variables
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let tokenAMintKeypair: Keypair;
  let tokenBMintKeypair: Keypair;
  let poolPda: PublicKey;
  let poolTokenA: PublicKey;
  let poolTokenB: PublicKey;
  let lpTokenMint: PublicKey;
  let feeCollectorTokenA: PublicKey;
  let feeCollectorTokenB: PublicKey;

  // Fee configuration
  const feeNumerator = 10;
  const feeDenominator = 1000;
  const protocolFeePercentage = 30; // 30% of the total fee goes to protocol fee collector

  before(async () => {
    // Setup test accounts
    adminWallet = provider.wallet as anchor.Wallet;
    admin = adminWallet.payer;
    unauthorizedAttacker = Keypair.generate();
    poolOwner = Keypair.generate();
    feeCollector = Keypair.generate();

    // Get DEX state PDA
    dexStatePda = PublicKey.findProgramAddressSync(
      [Buffer.from("dex_state"), adminWallet.publicKey.toBuffer()],
      program.programId
    )[0];

    // Airdrop SOL to test accounts
    await airdropIfNeeded(provider.connection, unauthorizedAttacker.publicKey);
    await airdropIfNeeded(provider.connection, poolOwner.publicKey);
    await airdropIfNeeded(provider.connection, feeCollector.publicKey);
  });

  // NOTE: Dex initialization with incorrect Admin Key is failing
  it("Dex initialization with incorrect Admin Key is failing", async () => {
    // Get PDA for unauthorized admin
    const unauthorizedDexStatePda = PublicKey.findProgramAddressSync(
      [Buffer.from("dex_state"), unauthorizedAttacker.publicKey.toBuffer()],
      program.programId
    )[0];

    const initializeAccounts = {
      admin: unauthorizedAttacker.publicKey,
      dexState: unauthorizedDexStatePda,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      // Try to initialize DEX with unauthorized admin
      await program.methods
        .initialize(
          new anchor.BN(feeNumerator),
          new anchor.BN(feeDenominator),
          protocolFeePercentage,
          feeCollector.publicKey
        )
        .accounts(initializeAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotAdmin");
    }
  });

  // NOTE: Dex initialization with correct Admin Key
  it("Dex initialization with correct Admin Key", async () => {
    const initializeAccounts = {
      admin: adminWallet.publicKey,
      dexState: dexStatePda,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Initialize DEX with correct admin
    await program.methods
      .initialize(
        new anchor.BN(feeNumerator),
        new anchor.BN(feeDenominator),
        protocolFeePercentage,
        feeCollector.publicKey
      )
      .accounts(initializeAccounts)
      .rpc();

    // Verify initialization
    const dexState = await program.account.dexState.fetch(dexStatePda);
    expect(dexState.poolsCount.toNumber()).to.equal(0);
    expect(dexState.admin.toBase58()).to.equal(adminWallet.publicKey.toBase58());
    expect(dexState.feeNumerator.toNumber()).to.equal(feeNumerator);
    expect(dexState.feeDenominator.toNumber()).to.equal(feeDenominator);
    expect(dexState.protocolFeePercentage).to.equal(protocolFeePercentage);
    expect(dexState.feeCollector.toBase58()).to.equal(feeCollector.publicKey.toBase58());
  });

  // NOTE: Creating a liquidity pool
  it("Creating a liquidity pool", async () => {
    // Create token mints
    tokenAMintKeypair = Keypair.generate();
    tokenBMintKeypair = Keypair.generate();
    tokenAMint = tokenAMintKeypair.publicKey;
    tokenBMint = tokenBMintKeypair.publicKey;

    // Create mints with 6 decimals
    await createMint(
      provider.connection,
      poolOwner,
      poolOwner.publicKey,
      null,
      6,
      tokenAMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await createMint(
      provider.connection,
      poolOwner,
      poolOwner.publicKey,
      null,
      6,
      tokenBMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get pool PDA and token accounts
    [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("liquidity_pool"),
        tokenAMint.toBuffer(),
        tokenBMint.toBuffer(),
      ],
      program.programId
    );

    // Generate LP token mint
    const lpTokenMintKeypair = Keypair.generate();
    lpTokenMint = lpTokenMintKeypair.publicKey;

    // Get associated token accounts
    poolTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    poolTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerLpToken = getAssociatedTokenAddressSync(
      lpTokenMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Create token accounts for pool
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        poolTokenA,
        poolPda,
        tokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        poolTokenB,
        poolPda,
        tokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [poolOwner]);

    const createPoolAccounts = {
      owner: poolOwner.publicKey,
      dexState: dexStatePda,
      tokenAMint,
      tokenBMint,
      pool: poolPda,
      poolTokenA,
      poolTokenB,
      lpTokenMint,
      ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Create the pool
    await program.methods
      .createPool()
      .accounts(createPoolAccounts)
      .signers([poolOwner, lpTokenMintKeypair])
      .rpc();

    // Verify pool creation
    const pool = await program.account.liquidityPool.fetch(poolPda);
    const dexState = await program.account.dexState.fetch(dexStatePda);
    const lpMintInfo = await getMint(
      provider.connection,
      lpTokenMint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Check pool state
    expect(pool.tokenAMint.toBase58()).to.equal(tokenAMint.toBase58());
    expect(pool.tokenBMint.toBase58()).to.equal(tokenBMint.toBase58());
    expect(pool.lpTokenMint.toBase58()).to.equal(lpTokenMint.toBase58());
    expect(pool.totalLiquidity.toNumber()).to.equal(0);
    expect(pool.feeNumerator.toNumber()).to.equal(dexState.feeNumerator.toNumber());
    expect(pool.feeDenominator.toNumber()).to.equal(dexState.feeDenominator.toNumber());
    expect(pool.protocolFeePercentage).to.equal(dexState.protocolFeePercentage);
    expect(pool.protocolFeesTokenA.toNumber()).to.equal(0);
    expect(pool.protocolFeesTokenB.toNumber()).to.equal(0);
    expect(dexState.poolsCount.toNumber()).to.equal(1);
    expect(lpMintInfo.decimals).to.equal(6);
  });

  // NOTE: Depositing and withdrawing liquidity
  it("Depositing and withdrawing liquidity", async () => {
    // Create user token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const poolAccount = await program.account.liquidityPool.fetch(poolPda);
    const ownerLpToken = getAssociatedTokenAddressSync(
      poolAccount.lpTokenMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Create user token accounts
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        ownerTokenA,
        poolOwner.publicKey,
        tokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        ownerTokenB,
        poolOwner.publicKey,
        tokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [poolOwner]);

    // Mint tokens to user
    const mintTx = new Transaction().add(
      createMintToInstruction(
        tokenAMint,
        ownerTokenA,
        poolOwner.publicKey,
        1000000,  // 1 token with 6 decimals
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        tokenBMint,
        ownerTokenB,
        poolOwner.publicKey,
        2000000,  // 2 tokens with 6 decimals
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(mintTx, [poolOwner]);

    // Deposit liquidity
    const tokenAAmount = 500000; // 0.5 tokens
    const tokenBAmount = 1000000; // 1 token

    const depositAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      lpTokenMint: poolAccount.lpTokenMint,
      userTokenA: ownerTokenA,
      userTokenB: ownerTokenB,
      userLpToken: ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .depositLiquidity(new anchor.BN(tokenAAmount), new anchor.BN(tokenBAmount))
      .accounts(depositAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after deposit
    const poolAfterDeposit = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerLpTokenBalance = await provider.connection.getTokenAccountBalance(ownerLpToken);

    // Withdraw half of LP tokens
    const lpAmountToWithdraw = Math.floor(Number(ownerLpTokenBalance.value.amount) / 2);

    const withdrawAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      lpTokenMint: poolAccount.lpTokenMint,
      userTokenA: ownerTokenA,
      userTokenB: ownerTokenB,
      userLpToken: ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .withdrawLiquidity(new anchor.BN(lpAmountToWithdraw))
      .accounts(withdrawAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after withdrawal
    const poolAfterWithdraw = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerLpTokenBalanceAfter = await provider.connection.getTokenAccountBalance(ownerLpToken);

    // Verify withdrawal
    expect(Number(poolAfterWithdraw.totalLiquidity.toString())).to.be.approximately(
      Number(poolAfterDeposit.totalLiquidity.toString()) - lpAmountToWithdraw,
      1 // Allow for rounding
    );

    expect(Number(ownerLpTokenBalanceAfter.value.amount)).to.be.approximately(
      Number(ownerLpTokenBalance.value.amount) - lpAmountToWithdraw,
      1 // Allow for rounding
    );

    expect(Number(poolTokenABalanceAfter.value.amount)).to.be.approximately(
      Number(poolTokenABalance.value.amount) / 2,
      10 // Allow for rounding
    );

    expect(Number(poolTokenBBalanceAfter.value.amount)).to.be.approximately(
      Number(poolTokenBBalance.value.amount) / 2,
      10 // Allow for rounding
    );
  });

  // NOTE: Swapping tokens
  it("Swapping tokens", async () => {
    // Get token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Ensure enough liquidity
    const poolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);

    // Add liquidity if needed
    if (
      Number(poolTokenABalance.value.amount) < 100000 ||
      Number(poolTokenBBalance.value.amount) < 100000
    ) {
      // Mint more tokens if needed
      const userTokenABalance = await provider.connection.getTokenAccountBalance(ownerTokenA);
      const userTokenBBalance = await provider.connection.getTokenAccountBalance(ownerTokenB);
      const mintTxs = new Transaction();

      if (Number(userTokenABalance.value.amount) < 500000) {
        mintTxs.add(
          createMintToInstruction(
            tokenAMint,
            ownerTokenA,
            poolOwner.publicKey,
            500000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      if (Number(userTokenBBalance.value.amount) < 500000) {
        mintTxs.add(
          createMintToInstruction(
            tokenBMint,
            ownerTokenB,
            poolOwner.publicKey,
            500000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      if (mintTxs.instructions.length > 0) {
        await provider.sendAndConfirm(mintTxs, [poolOwner]);
      }

      // Deposit additional liquidity
      const poolAccount = await program.account.liquidityPool.fetch(poolPda);
      const ownerLpToken = getAssociatedTokenAddressSync(
        poolAccount.lpTokenMint,
        poolOwner.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      );

      const additionalDepositAccounts = {
        owner: poolOwner.publicKey,
        pool: poolPda,
        tokenAMint,
        tokenBMint,
        poolTokenA,
        poolTokenB,
        lpTokenMint: poolAccount.lpTokenMint,
        userTokenA: ownerTokenA,
        userTokenB: ownerTokenB,
        userLpToken: ownerLpToken,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      };

      await program.methods
        .depositLiquidity(new anchor.BN(200000), new anchor.BN(400000))
        .accounts(additionalDepositAccounts)
        .signers([poolOwner])
        .rpc();
    }

    // Get pool data before swap
    const poolBeforeSwap = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerTokenABalanceBefore = await provider.connection.getTokenAccountBalance(ownerTokenA);
    const ownerTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(ownerTokenB);

    // Check protocol fee accumulations before swap
    const protocolFeesTokenABefore = poolBeforeSwap.protocolFeesTokenA.toNumber();

    // Calculate expected output with fee
    const inputAmount = 50000; // 0.05 token A
    const reserveA = Number(poolTokenABalanceBefore.value.amount);
    const reserveB = Number(poolTokenBBalanceBefore.value.amount);
    const feeNumerator = poolBeforeSwap.feeNumerator.toNumber();
    const feeDenominator = poolBeforeSwap.feeDenominator.toNumber();

    // Calculate total fee
    const totalFeeAmount = Math.floor(inputAmount * feeNumerator / feeDenominator);

    // Calculate protocol fee portion
    const protocolFeeAmount = Math.floor(totalFeeAmount * protocolFeePercentage / 100);

    // Calculate input after fee
    const inputWithFee = inputAmount - totalFeeAmount;

    const expectedOutput = Math.floor((reserveB * inputWithFee) / (reserveA + inputWithFee));
    const minimumOutputAmount = Math.floor(expectedOutput * 0.99); // 1% slippage

    const swapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenAMint,
      destinationMint: tokenBMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenA,
      userDestinationToken: ownerTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Execute swap A to B
    await program.methods
      .swap(
        new anchor.BN(inputAmount),
        new anchor.BN(minimumOutputAmount)
      )
      .accounts(swapAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after swap
    const poolAfterSwap = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerTokenABalanceAfter = await provider.connection.getTokenAccountBalance(ownerTokenA);
    const ownerTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(ownerTokenB);

    // Verify protocol fee accumulation
    const protocolFeesTokenAAfter = poolAfterSwap.protocolFeesTokenA.toNumber();
    expect(protocolFeesTokenAAfter - protocolFeesTokenABefore).to.be.approximately(
      protocolFeeAmount,
      1 // Allow for rounding
    );

    // Verify swap
    const actualOutputAmount = Number(ownerTokenBBalanceAfter.value.amount) - Number(ownerTokenBBalanceBefore.value.amount);

    expect(
      Number(poolTokenABalanceAfter.value.amount) - Number(poolTokenABalanceBefore.value.amount)
    ).to.equal(inputAmount);

    expect(
      Number(poolTokenBBalanceBefore.value.amount) - Number(poolTokenBBalanceAfter.value.amount)
    ).to.equal(actualOutputAmount);

    expect(
      Number(ownerTokenABalanceBefore.value.amount) - Number(ownerTokenABalanceAfter.value.amount)
    ).to.equal(inputAmount);

    expect(actualOutputAmount).to.be.at.least(minimumOutputAmount);

    // Verify constant product formula holds (with fee increase)
    const productBefore = Number(poolTokenABalanceBefore.value.amount) * Number(poolTokenBBalanceBefore.value.amount);
    const productAfter = Number(poolTokenABalanceAfter.value.amount) * Number(poolTokenBBalanceAfter.value.amount);
    expect(productAfter).to.be.greaterThan(productBefore * 0.99);

    // Test reverse swap (B to A)
    const reverseInputAmount = 30000; // 0.03 token B
    const reverseReserveA = Number(poolTokenABalanceAfter.value.amount);
    const reverseReserveB = Number(poolTokenBBalanceAfter.value.amount);

    // Calculate total fee for reverse swap
    const reverseTotalFeeAmount = Math.floor(reverseInputAmount * feeNumerator / feeDenominator);

    // Calculate protocol fee portion for reverse swap
    const reverseProtocolFeeAmount = Math.floor(reverseTotalFeeAmount * protocolFeePercentage / 100);

    // Calculate input after fee for reverse swap
    const reverseInputWithFee = reverseInputAmount - reverseTotalFeeAmount;

    const reverseExpectedOutput = Math.floor((reverseReserveA * reverseInputWithFee) / (reverseReserveB + reverseInputWithFee));
    const reverseMinimumOutput = Math.floor(reverseExpectedOutput * 0.99);

    // Check protocol fee accumulations before reverse swap
    const protocolFeesTokenBBeforeReverseSwap = poolAfterSwap.protocolFeesTokenB.toNumber();

    const reverseSwapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenBMint,
      destinationMint: tokenAMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenB,
      userDestinationToken: ownerTokenA,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Execute reverse swap
    await program.methods
      .swap(
        new anchor.BN(reverseInputAmount),
        new anchor.BN(reverseMinimumOutput)
      )
      .accounts(reverseSwapAccounts)
      .signers([poolOwner])
      .rpc();

    // Get final balances
    const poolAfterReverseSwap = await program.account.liquidityPool.fetch(poolPda);
    const finalPoolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const finalPoolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);
    const finalOwnerTokenABalance = await provider.connection.getTokenAccountBalance(ownerTokenA);

    // Verify protocol fee accumulation for reverse swap
    const protocolFeesTokenBAfterReverseSwap = poolAfterReverseSwap.protocolFeesTokenB.toNumber();
    expect(protocolFeesTokenBAfterReverseSwap - protocolFeesTokenBBeforeReverseSwap).to.be.approximately(
      reverseProtocolFeeAmount,
      1 // Allow for rounding
    );

    // Verify reverse swap
    const reverseActualOutput = Number(finalOwnerTokenABalance.value.amount) - Number(ownerTokenABalanceAfter.value.amount);

    expect(
      Number(finalPoolTokenBBalance.value.amount) - Number(poolTokenBBalanceAfter.value.amount)
    ).to.equal(reverseInputAmount);

    expect(
      Number(poolTokenABalanceAfter.value.amount) - Number(finalPoolTokenABalance.value.amount)
    ).to.equal(reverseActualOutput);

    expect(reverseActualOutput).to.be.at.least(reverseMinimumOutput);
  });

  // NOTE: Collecting protocol fees
  it("Collecting protocol fees", async () => {
    // Create fee collector token accounts
    feeCollectorTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      feeCollector.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    feeCollectorTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      feeCollector.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Create fee collector token accounts if they don't exist
    const setupFeeCollectorTx = new Transaction();

    setupFeeCollectorTx.add(
      createAssociatedTokenAccountInstruction(
        adminWallet.publicKey,
        feeCollectorTokenA,
        feeCollector.publicKey,
        tokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        adminWallet.publicKey,
        feeCollectorTokenB,
        feeCollector.publicKey,
        tokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupFeeCollectorTx, [admin]);

    // Get current protocol fees
    const poolBeforeCollection = await program.account.liquidityPool.fetch(poolPda);
    const protocolFeesTokenABefore = poolBeforeCollection.protocolFeesTokenA.toNumber();
    const protocolFeesTokenBBefore = poolBeforeCollection.protocolFeesTokenB.toNumber();

    // Get fee collector balances before collection
    const feeCollectorTokenABalanceBefore = await provider.connection.getTokenAccountBalance(feeCollectorTokenA);
    const feeCollectorTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(feeCollectorTokenB);

    // Ensure we have fees to collect
    expect(protocolFeesTokenABefore + protocolFeesTokenBBefore).to.be.greaterThan(0);

    // Collect fees
    const collectFeesAccounts = {
      admin: adminWallet.publicKey,
      dexState: dexStatePda,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      feeCollectorTokenA,
      feeCollectorTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    };

    await program.methods
      .collectFees()
      .accounts(collectFeesAccounts)
      .rpc();

    // Get pool and balances after collection
    const poolAfterCollection = await program.account.liquidityPool.fetch(poolPda);
    const feeCollectorTokenABalanceAfter = await provider.connection.getTokenAccountBalance(feeCollectorTokenA);
    const feeCollectorTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(feeCollectorTokenB);

    // Verify that protocol fees were transferred to fee collector
    expect(poolAfterCollection.protocolFeesTokenA.toNumber()).to.equal(0);
    expect(poolAfterCollection.protocolFeesTokenB.toNumber()).to.equal(0);

    // Verify fee collector received the fees
    const tokenAFeeCollected = Number(feeCollectorTokenABalanceAfter.value.amount) -
      Number(feeCollectorTokenABalanceBefore.value.amount || 0);
    const tokenBFeeCollected = Number(feeCollectorTokenBBalanceAfter.value.amount) -
      Number(feeCollectorTokenBBalanceBefore.value.amount || 0);

    expect(tokenAFeeCollected).to.equal(protocolFeesTokenABefore);
    expect(tokenBFeeCollected).to.equal(protocolFeesTokenBBefore);
  });

  // NOTE: Unauthorized fee collection attempt
  it("Unauthorized fee collection fails", async () => {
    // Try to collect fees with unauthorized user
    const collectFeesAccounts = {
      admin: unauthorizedAttacker.publicKey,
      dexState: dexStatePda,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      feeCollectorTokenA,
      feeCollectorTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    };

    try {
      await program.methods
        .collectFees()
        .accounts(collectFeesAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotAdmin");
    }
  });
});

/**
 * Airdrops SOL to a given public key if the balance is below a specified threshold.
 */
async function airdropIfNeeded(
  connection: Connection,
  publicKey: PublicKey,
  minBalanceInSol: number = DEFAULT_AIRDROP_SOL
): Promise<void> {
  const currentBalance = await connection.getBalance(publicKey);
  const currentBalanceInSol = currentBalance / LAMPORTS_PER_SOL;

  if (currentBalanceInSol < minBalanceInSol) {
    const requiredAirdrop = minBalanceInSol - currentBalanceInSol;
    const signature = await connection.requestAirdrop(
      publicKey,
      requiredAirdrop * LAMPORTS_PER_SOL
    );

    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
  }
}
